"""Hierarchy reads: hosts, corpora, projects, transcripts, unattributed.

Split out of :mod:`src.core.archive_read` under section 8.1 of
``docs/message-browser-api.md``, which sanctions exactly this split rather
than letting that module pass the repo's 500-line cap.

Everything returns a full envelope from :func:`archive_read.envelope`.
Routes do not build response dicts.

THE MISSING-ROW SHAPE IS THE THEME OF THIS FILE. Two conditions look
alike and are not the same thing:

* ``project_id IS NULL`` - NAVIGATION. 5 transcripts belong to a corpus
  and to no project, so every path reaching a transcript through a
  project cannot reach them. Counted in
  ``unattributed_transcript_count`` on every corpus row and projects
  page; read via :func:`unattributed_for_corpus`.
* ``host_attribution = 'cannot_determine'`` - QUALITY. 3 transcripts HAVE
  a ``host_id`` and are unevidenced. They stay under their host, are
  never moved into the unattributed bucket, and their
  ``attribution_state`` says so.

Moving the second group into the first files three transcripts under a
heading that does not describe them, which is how they stop being looked
at.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Dict, List, Optional, Tuple

from src.core.archive_cursor import (
    CURSOR_PROJECTS,
    CURSOR_TRANSCRIPTS,
    CURSOR_UNATTRIBUTED,
    CursorError,
    decode_cursor,
    encode_cursor,
)
from src.core.archive_read import (
    API_PREFIX,
    DEFAULT_PAGE_LIMIT,
    MAX_PAGE_LIMIT,
    RESULT_OK,
    attribution_state,
    clamp_limit,
    count_int,
    cursor_error_envelope,
    envelope,
    not_found_envelope,
    paged_rows,
    paging_meta,
    scalar,
    unread_paging,
)

#: Columns every transcript row carries, on BOTH listings. Section 6.5's
#: SQL selects a subset of 6.4's; one shared superset is used instead so
#: the same entity does not arrive with two shapes depending on which
#: route a client reached it through.
_TRANSCRIPT_COLUMNS = """
       t.id, t.session_ref, t.session_ref_scheme, t.source_path,
       t.line_count, t.raw_byte_length, t.content_sha256, t.ingested_at,
       t.line_ending, t.has_trailing_newline,
       t.host_attribution, t.project_attribution
"""


def _transcript_row(row: sqlite3.Row) -> Dict[str, Any]:
    """Shape one transcript listing row for a client.

    Description: ``attribution_state`` is derived here and nowhere else,
      so the two listings cannot disagree about whether a transcript's
      host attribution is evidenced.
    Inputs: row (sqlite3.Row) selected with _TRANSCRIPT_COLUMNS.
    Output: dict. Example: _transcript_row(r)["attribution_state"]
    """
    return {
        "transcript_id": row["id"],
        "session_ref": row["session_ref"],
        "session_ref_scheme": row["session_ref_scheme"],
        "source_path": row["source_path"],
        "line_count": row["line_count"],
        "raw_byte_length": row["raw_byte_length"],
        "content_sha256": row["content_sha256"],
        "ingested_at": row["ingested_at"],
        "line_ending": row["line_ending"],
        "has_trailing_newline": bool(row["has_trailing_newline"]),
        "host_attribution": row["host_attribution"],
        "project_attribution": row["project_attribution"],
        "attribution_state": attribution_state(row["host_attribution"]),
    }


def hosts(conn: sqlite3.Connection) -> Dict[str, Any]:
    """List every host, with its corpus and transcript counts.

    Description: not paginated - bounded by the number of physical
      machines the owner has, measured at 2, in 0.0006s.
      ``transcripts_with_no_host_id`` is emitted ALWAYS, including at 0,
      so a client can tell "every transcript is attributed" from "the
      question was not asked".
    Inputs: conn (sqlite3.Connection). Output: envelope; ``result`` is a
      list of host dicts. Example: hosts(conn)["result"][0]["host_id"]
    """
    rows = conn.execute(
        """
        SELECT h.id, h.machine_id, h.machine_id_scheme, h.display_name,
               h.hostname, h.platform, h.first_seen_at,
               (SELECT COUNT(*) FROM message_corpora k WHERE k.host_id = h.id)
                 AS corpus_count,
               (SELECT COUNT(*) FROM message_transcripts t WHERE t.host_id = h.id)
                 AS transcript_count
          FROM message_hosts h
         ORDER BY h.id
        """
    ).fetchall()
    result = [
        {
            "host_id": row["id"],
            "machine_id": row["machine_id"],
            "machine_id_scheme": row["machine_id_scheme"],
            "display_name": row["display_name"],
            "hostname": row["hostname"],
            "platform": row["platform"],
            "first_seen_at": row["first_seen_at"],
            "corpus_count": row["corpus_count"],
            "transcript_count": row["transcript_count"],
        }
        for row in rows
    ]
    attributed = count_int(
        scalar(
            conn,
            "SELECT COUNT(*) FROM message_transcripts WHERE host_id IS NOT NULL",
        )
    )
    orphaned = count_int(
        scalar(conn, "SELECT COUNT(*) FROM message_transcripts WHERE host_id IS NULL")
    )
    return envelope(
        result=result,
        result_status=RESULT_OK,
        meta={
            "totals": {
                "hosts": len(result),
                "transcripts_attributed_to_a_host": attributed,
                "transcripts_with_no_host_id": orphaned,
            }
        },
    )


def corpora_for_host(conn: sqlite3.Connection, host_id: int) -> Dict[str, Any]:
    """List the corpora collected from one host.

    Description: not paginated - measured 3 rows across the fleet.
      ``manifest_sha`` is NOT returned, only whether one exists.
      ``unattributed_transcript_count`` is why this carries counts - without
      it a client renders a corpus's projects and project-attached
      transcripts, and the project-less ones are invisible BY CONSTRUCTION.
    Inputs: conn (sqlite3.Connection), host_id (int).
    Output: envelope; ``result`` is a list, or ``[]`` with ``not_found``
      when the host does not exist.
    """
    host = conn.execute(
        "SELECT id, display_name FROM message_hosts WHERE id = ?", (host_id,)
    ).fetchone()
    if host is None:
        return not_found_envelope(
            f"host:{host_id}",
            f"no row in message_hosts with id {host_id}",
            result=[],
        )
    rows = conn.execute(
        """
        SELECT k.id, k.corpus_key, k.root_path, k.collected_at,
               k.manifest_sha IS NOT NULL AS has_manifest,
               (SELECT COUNT(*) FROM message_projects p WHERE p.corpus_id = k.id)
                 AS project_count,
               (SELECT COUNT(*) FROM message_transcripts t WHERE t.corpus_id = k.id)
                 AS transcript_count,
               (SELECT COUNT(*) FROM message_transcripts t
                 WHERE t.corpus_id = k.id AND t.project_id IS NULL)
                 AS unattributed_transcript_count
          FROM message_corpora k
         WHERE k.host_id = ?
         ORDER BY k.id
        """,
        (host_id,),
    ).fetchall()
    result = [
        {
            "corpus_id": row["id"],
            "corpus_key": row["corpus_key"],
            "root_path": row["root_path"],
            "collected_at": row["collected_at"],
            "has_manifest": bool(row["has_manifest"]),
            "project_count": row["project_count"],
            "transcript_count": row["transcript_count"],
            "unattributed_transcript_count": row["unattributed_transcript_count"],
        }
        for row in rows
    ]
    return envelope(
        result=result,
        result_status=RESULT_OK,
        meta={
            "scope": {
                "kind": "host",
                "host_id": host_id,
                "display_name": host["display_name"],
            }
        },
    )


def projects_for_corpus(
    conn: sqlite3.Connection,
    corpus_id: int,
    *,
    limit: Optional[int] = None,
    cursor: Optional[str] = None,
) -> Dict[str, Any]:
    """Page the projects in one corpus, ordered by slug.

    Description: keyed on ``slug``, needing no synthetic tie-break
      because ``message_projects`` is ``UNIQUE (corpus_id, slug)`` - that
      composite serves equality and range in ONE index search, no temp
      b-tree. Counts come from one grouped scan, measured 0.0102s. The
      ``meta.unattributed`` block is on EVERY page so a client paging
      projects cannot finish believing it saw the whole corpus.
    Inputs: conn, corpus_id (int), limit (int|None, clamped to
      1..MAX_PAGE_LIMIT), cursor (str|None, opaque).
    Output: envelope; ``result`` is a list of project dicts.
    """
    size = clamp_limit(limit, default=DEFAULT_PAGE_LIMIT, maximum=MAX_PAGE_LIMIT)
    cursor_slug: Optional[str] = None
    if cursor is not None:
        try:
            cursor_slug = str(decode_cursor(CURSOR_PROJECTS, cursor)["slug"])
        except CursorError as exc:
            return cursor_error_envelope(exc, limit=size)
    if scalar(conn, "SELECT id FROM message_corpora WHERE id = ?", (corpus_id,)) is None:
        return not_found_envelope(
            f"corpus:{corpus_id}",
            f"no row in message_corpora with id {corpus_id}",
            result=[],
            meta={"paging": unread_paging(size)},
        )
    rows = conn.execute(
        """
        SELECT p.id, p.slug, p.observed_cwd, p.first_seen_at
          FROM message_projects p
         WHERE p.corpus_id = :corpus_id
           AND (:cursor_slug IS NULL OR p.slug > :cursor_slug)
         ORDER BY p.slug
         LIMIT :limit_plus_one
        """,
        {
            "corpus_id": corpus_id,
            "cursor_slug": cursor_slug,
            "limit_plus_one": size + 1,
        },
    ).fetchall()
    page, has_more = paged_rows(rows, size)
    counts: Dict[Any, int] = {
        row["project_id"]: row["n"]
        for row in conn.execute(
            """
            SELECT project_id, COUNT(*) AS n
              FROM message_transcripts
             WHERE corpus_id = ?
             GROUP BY project_id
            """,
            (corpus_id,),
        ).fetchall()
    }
    result = [
        {
            "project_id": row["id"],
            "slug": row["slug"],
            "observed_cwd": row["observed_cwd"],
            "first_seen_at": row["first_seen_at"],
            "transcript_count": counts.get(row["id"], 0),
        }
        for row in page
    ]
    next_cursor = (
        encode_cursor(CURSOR_PROJECTS, {"slug": page[-1]["slug"]})
        if has_more and page
        else None
    )
    corpus_key = scalar(
        conn, "SELECT corpus_key FROM message_corpora WHERE id = ?", (corpus_id,)
    )
    return envelope(
        result=result,
        result_status=RESULT_OK,
        meta={
            "paging": paging_meta(
                limit=size,
                returned=len(result),
                has_more=has_more,
                next_cursor=next_cursor,
            ),
            "scope": {
                "kind": "corpus",
                "corpus_id": corpus_id,
                "corpus_key": corpus_key,
            },
            "unattributed": {
                "transcript_count": counts.get(None, 0),
                "href": f"{API_PREFIX}/corpora/{corpus_id}/unattributed",
            },
        },
    )


def _transcript_page(
    conn: sqlite3.Connection,
    *,
    where: str,
    params: Dict[str, Any],
    size: int,
    cursor: Optional[str],
    kind: str,
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]], bool, Optional[str]]:
    """Run one ``(ingested_at DESC, id DESC)`` keyset page of transcripts.

    Description: the shared body of the project and unattributed
      listings. The first page omits the keyset clause by passing NULL
      rather than a sentinel timestamp: a sentinel works today and is a
      landmine, because the day a timestamp sorts above it page 1
      silently returns nothing. ``id DESC`` is NOT a theoretical
      tie-break - all 21,039 transcripts were ingested in a few batches
      and ``ingested_at`` repeats at microsecond resolution.
    Inputs: conn, where (str) - scope predicate, params (dict) - its
      bindings, size (int), cursor (str|None), kind (str).
    Output: (error envelope or None, rows, has_more, next_cursor). The
      first is non-None ONLY when the cursor would not parse; the caller
      returns it unchanged.
    """
    cur_ts: Optional[str] = None
    cur_id: Optional[int] = None
    if cursor is not None:
        try:
            payload = decode_cursor(kind, cursor)
            cur_ts = str(payload["ingested_at"])
            cur_id = int(payload["id"])
        except CursorError as exc:
            # result=None, NEVER []. See section 3.1.1 of
            # docs/message-browser-api.md: an [] here reads as "no
            # transcripts" to a client that ignores result_status.
            return cursor_error_envelope(exc, limit=size, result=None), [], False, None
    bindings = dict(params)
    bindings.update({"cur_ts": cur_ts, "cur_id": cur_id, "limit_plus_one": size + 1})
    rows = conn.execute(
        f"""
        SELECT {_TRANSCRIPT_COLUMNS}
          FROM message_transcripts t
         WHERE {where}
           AND (:cur_ts IS NULL
                OR t.ingested_at < :cur_ts
                OR (t.ingested_at = :cur_ts AND t.id < :cur_id))
         ORDER BY t.ingested_at DESC, t.id DESC
         LIMIT :limit_plus_one
        """,
        bindings,
    ).fetchall()
    page, has_more = paged_rows(rows, size)
    shaped = [_transcript_row(row) for row in page]
    next_cursor = (
        encode_cursor(
            kind,
            {"ingested_at": page[-1]["ingested_at"], "id": page[-1]["id"]},
        )
        if has_more and page
        else None
    )
    return None, shaped, has_more, next_cursor


def transcripts_for_project(
    conn: sqlite3.Connection,
    project_id: int,
    *,
    limit: Optional[int] = None,
    cursor: Optional[str] = None,
) -> Dict[str, Any]:
    """Page one project's transcripts, newest ingest first.

    Description: measured 1.8ms on the largest project (3,416
      transcripts). The temp b-tree that sort costs is accepted
      deliberately; section 10.1 carries the re-measure trigger, so
      nobody adds an index on a hunch.
    Inputs: conn, project_id (int), limit (int|None), cursor (str|None).
    Output: envelope; ``result`` is a list of transcript dicts, or ``[]``
      with ``not_found`` when the project does not exist.
    """
    size = clamp_limit(limit, default=DEFAULT_PAGE_LIMIT, maximum=MAX_PAGE_LIMIT)
    project = conn.execute(
        "SELECT id, slug FROM message_projects WHERE id = ?", (project_id,)
    ).fetchone()
    if project is None:
        return not_found_envelope(
            f"project:{project_id}",
            f"no row in message_projects with id {project_id}",
            result=[],
            meta={"paging": unread_paging(size)},
        )
    failure, rows, has_more, next_cursor = _transcript_page(
        conn,
        where="t.project_id = :project_id",
        params={"project_id": project_id},
        size=size,
        cursor=cursor,
        kind=CURSOR_TRANSCRIPTS,
    )
    if failure is not None:
        return failure
    return envelope(
        result=rows,
        result_status=RESULT_OK,
        meta={
            "paging": paging_meta(
                limit=size,
                returned=len(rows),
                has_more=has_more,
                next_cursor=next_cursor,
            ),
            "scope": {
                "kind": "project",
                "project_id": project_id,
                "slug": project["slug"],
            },
        },
    )


def unattributed_for_corpus(
    conn: sqlite3.Connection,
    corpus_id: int,
    *,
    limit: Optional[int] = None,
    cursor: Optional[str] = None,
) -> Dict[str, Any]:
    """Page the transcripts that belong to a corpus but to NO project.

    Description: without this route those transcripts are unreachable by
      navigation, since every other path into a transcript goes through a
      project. ``project_id IS NULL`` is an unindexed post-filter on the
      corpus range, so this is the one route whose cost is proportional to
      the corpus rather than the answer - measured 0.0079s over 19,548
      rows for 0 matches. An ``ok`` with an empty list means GENUINELY
      EMPTY, and ``meta.note`` says so in words.
    Inputs: conn, corpus_id (int), limit (int|None), cursor (str|None).
    Output: envelope; ``result`` is a list of transcript dicts.
    """
    size = clamp_limit(limit, default=DEFAULT_PAGE_LIMIT, maximum=MAX_PAGE_LIMIT)
    if scalar(conn, "SELECT id FROM message_corpora WHERE id = ?", (corpus_id,)) is None:
        return not_found_envelope(
            f"corpus:{corpus_id}",
            f"no row in message_corpora with id {corpus_id}",
            result=[],
            meta={"paging": unread_paging(size)},
        )
    failure, rows, has_more, next_cursor = _transcript_page(
        conn,
        where="t.corpus_id = :corpus_id AND t.project_id IS NULL",
        params={"corpus_id": corpus_id},
        size=size,
        cursor=cursor,
        kind=CURSOR_UNATTRIBUTED,
    )
    if failure is not None:
        return failure
    total = count_int(
        scalar(
            conn,
            "SELECT COUNT(*) FROM message_transcripts "
            "WHERE corpus_id = ? AND project_id IS NULL",
            (corpus_id,),
        )
    )
    meta: Dict[str, Any] = {
        "paging": paging_meta(
            limit=size,
            returned=len(rows),
            has_more=has_more,
            next_cursor=next_cursor,
        ),
        "scope": {"kind": "corpus", "corpus_id": corpus_id},
        "unattributed_transcript_count": total,
    }
    if total == 0:
        meta["note"] = "every transcript in this corpus resolved to a project"
    return envelope(result=rows, result_status=RESULT_OK, meta=meta)
