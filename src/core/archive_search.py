"""Scoped, byte-budgeted substring search over ingested message bodies.

MEASURED (spec 6.11, 7.2, 12.4): an unscoped scan is 7.76 GB at
0.44 GB/s, about 17.6s on a shared event loop, and per-transcript cost
spans 0.4 ms to 405.6 ms - a factor of about 1,000 - so ``MAX_SCAN_BYTES``
is the PRIMARY governor and ``MAX_SCAN_BUDGET`` only a secondary cap.

THE PROPERTY THIS PROTECTS: searched-everything-and-found-nothing and
ran-out-of-budget must never render identically. The first is ok /
complete / not_scanned 0 / empty unevaluated / null resume_cursor; the
second differs in ALL FIVE and resumes. Collapsing them into an empty
list is the false green THE THREE-OUTCOME RULE forbids.

SECRETS: the only field withheld is the PREVIEW, and a withheld hit is
still REPORTED with transcript, line, offset and length.
``secret_finding_count > 0`` was once the WHOLE gate and was measured
wrong (2026-08-31: 415 of the 762 bodies holding one credential carry no
finding). It is now layer 1 of 3; ``archive_snippet_gate`` holds the
rest and the honest statement of what they do not promise. Matching is ``INSTR`` not ``LIKE``: it yields the offset in the same
pass and makes ``%``, ``_`` and a backslash literal, so no unescaped
``%`` can widen a search.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from src.core.archive_cursor import (
    CURSOR_LINES,
    CURSOR_SEARCH,
    CURSOR_VERSION,
    CursorError,
    decode_cursor,
    encode_cursor,
)
from src.core.archive_snippet_gate import (  # noqa: F401  re-exported
    SNIPPET_INCLUDED, SNIPPET_WITHHELD_BY_REQUEST,
    SNIPPET_WITHHELD_FLAGGED_BODY, KnownSecretIndex, build_hit, load_index,
    snippet_gate_meta,
)
from src.core.archive_search_fts import (
    LINE_DONE,  # noqa: F401  re-exported; declared beside its keyset
    ORDER_MODES,
    ORDER_POSITION,
    ORDER_RELEVANCE,  # noqa: F401  re-exported for the route
    BlockFilters,
    query_is_tokenizable,
    run_hit_query,
)
from src.core.archive_search_hit import build_fts_hit
from src.core.message_block_search_state import read_liveness
from src.core.message_block_search_ddl import BLOCK_SEARCH_TOKENIZER
from src.core.message_block_search_status import (
    COVERAGE_INDEXED,
    INDEX_STALE,
    Coverage,
    probe_index_state,
    resolve_coverage,
)
from src.core.archive_read import (
    MAX_PAGE_LIMIT,
    MAX_SCAN_BUDGET,
    MAX_SCAN_BYTES,
    RESULT_CANNOT_DETERMINE,
    RESULT_NOT_FOUND,
    RESULT_OK,
    RESULT_PARTIAL,
    SCOPE_CANNOT_DETERMINE,
    SCOPE_NOT_FOUND,
    SCOPE_RESOLVED,
    envelope,
    offset_units_meta,
)

# --- Vocabulary and bounds -------------------------------------------------
#: A global search is excluded by spec 7.2, not missing; adding one is a
#: regression.
SCOPE_PROJECT = "project"
SCOPE_TRANSCRIPT = "transcript"
SCOPE_KINDS: Tuple[str, ...] = (SCOPE_PROJECT, SCOPE_TRANSCRIPT)

#: ``limit_reached`` is NOT in the spec's two worked examples and is
#: deliberate: a scan stopped by a full page is neither ``complete``
#: (scope not exhausted) nor ``budget_exhausted`` (no budget spent), and
#: either is a verdict nobody measured. ``not_run`` means no scan ran, so
#: every count is None - 0 would be a measurement.
SCAN_COMPLETE = "complete"
SCAN_BUDGET_EXHAUSTED = "budget_exhausted"
SCAN_LIMIT_REACHED = "limit_reached"
SCAN_NOT_RUN = "not_run"

#: How the haystack was reached. Named because ``bytes_scanned`` is
#: now legitimately 0 - the index answered and no body was read - and a
#: zero with no explanation beside it reads as a broken counter.
SCAN_METHOD_FTS = "fts_index"
#: Kept as the historical name for the body-flag layer, so a caller
#: importing it still gets the state that layer emits.
SNIPPET_WITHHELD_SECRET = SNIPPET_WITHHELD_FLAGGED_BODY

#: ``LINE_DONE`` is declared in ``archive_search_fts`` beside the keyset
#: that reads it, and re-exported here so an existing importer of
#: ``archive_search.LINE_DONE`` still resolves. One declaration, two
#: names for it, rather than two declarations.

#: A snippet is not a body and is never placed in ``body_json`` (spec 1
#: rule 3); ``SNIPPET_CONTEXT_CHARS`` is the window either side.
DEFAULT_SEARCH_LIMIT = 50
MIN_QUERY_CHARS = 2
MAX_QUERY_CHARS = 200


class SearchInputError(ValueError):
    """A caller-supplied argument could not be evaluated.

    Carries the ``subject``/``reason`` pair that goes straight into the
    envelope's ``unevaluated`` list, so a refusal is never reduced to a
    bare exception type.
    """

    def __init__(self, subject: str, reason: str) -> None:
        super().__init__(f"{subject}: {reason}")
        self.subject = subject
        self.reason = reason


# --- SQL -------------------------------------------------------------------
# THE MATCHER MOVED, AND THAT IS THE POINT OF THIS VERSION.
# ``INSTR(b.body_json, needle)`` used to run here over the WHOLE jsonl
# record - cwd, sessionId, parentUuid, timestamp, gitBranch, entrypoint,
# version, promptId and the message together - so a search for a model
# name matched the envelope of every message that model produced.
# Measured on the 400-transcript projection, 2026-09-13: ``claude-opus-4``
# returned 33,805 bodies of which 165 carried it in real message text;
# ``"cache_read_input_tokens"`` 91,623 against 30. A miss cost 919 ms.
#
# The matcher is now ``src/core/archive_search_fts.py``: the FTS5 index
# over ``message_content_blocks.text`` narrows the corpus, and ``INSTR``
# over those blocks' own text still decides the literal match and its
# offset, so the substring contract and ``case_sensitive`` are unchanged
# while the haystack is 0.001 percent of the size.
#
# KNOWN GAP, recorded not hidden, and NARROWED rather than closed: the
# old JOIN dropped appearance rows with a NULL body_id (1 of 3,125,122 -
# the line that failed to parse at ingest). That row still has no body,
# and now it also has no content block, so it is still a CANNOT DETERMINE
# rendered as an absence. It is now REPORTABLE: ``meta.coverage`` counts
# every body in scope that is outside the index and says why.

_TRANSCRIPT_COLUMNS = "id, session_ref, ingested_at, raw_byte_length"
_PROJECT_EXISTS_SQL = "SELECT id FROM message_projects WHERE id = ?"
_PROJECT_COUNT_SQL = "SELECT COUNT(*) FROM message_transcripts WHERE project_id = ?"

_TRANSCRIPT_ROW_SQL = (
    f"SELECT {_TRANSCRIPT_COLUMNS} FROM message_transcripts WHERE id = ?"
)

# --- Input validation - each defect names its own subject ------------------


def _validate_inputs(
    q: str, scope: str, scope_id: Any, limit: int,
    scan_budget: int, scan_bytes: int,
) -> None:
    """Refuse an unanswerable request before any SQL runs. Nothing is
    clamped: narrowing a caller's limit silently produces a short page
    that reads as the end of the results.

    Inputs: q, scope, scope_id, limit, scan_budget, scan_bytes. Output:
      None. Raises: SearchInputError - subject and reason.
    """
    def is_int(value: Any) -> bool:
        return isinstance(value, int) and not isinstance(value, bool)
    text = isinstance(q, str)  # a non-str q fails the blank check first
    checks: Tuple[Tuple[bool, str, str], ...] = (
        (scope in SCOPE_KINDS, "scope",
         f"scope must be one of {list(SCOPE_KINDS)}; got {scope!r}. There "
         "is no unscoped search: it is about 17.6 seconds per request."),
        (is_int(scope_id), f"{scope}_id",
         f"scope_id must be an int; got {type(scope_id).__name__}"),
        (text and bool(q.strip()), "q", "q is required and must not be blank"),
        (text and MIN_QUERY_CHARS <= len(q) <= MAX_QUERY_CHARS, "q",
         f"q must be {MIN_QUERY_CHARS} to {MAX_QUERY_CHARS} characters"),
        (is_int(limit) and 1 <= limit <= MAX_PAGE_LIMIT, "limit",
         f"limit must be 1 to {MAX_PAGE_LIMIT}"),
        (is_int(scan_budget) and 1 <= scan_budget <= MAX_SCAN_BUDGET,
         "scan_budget",
         f"scan_budget must be 1 to {MAX_SCAN_BUDGET} transcripts"),
        (is_int(scan_bytes) and 1 <= scan_bytes <= MAX_SCAN_BYTES,
         "scan_bytes", f"scan_bytes must be 1 to {MAX_SCAN_BYTES} bytes"),
    )
    for ok, subject, reason in checks:
        if not ok:
            raise SearchInputError(subject, reason)


def _decode_resume(
    cursor: Optional[str], scope: str, scope_id: int,
) -> Optional[Dict[str, Any]]:
    """Parse a resume cursor, or refuse. NEVER restart at the beginning:
    treating a malformed cursor as "start at page 1" turns a client bug
    into an infinite duplicate-rendering loop that looks like it works.

    Inputs: cursor (str or None), scope, scope_id. Output: the decoded
      payload, or None when no cursor was supplied.
    Raises: SearchInputError - anything decode_cursor rejects, or a
      cursor minted against a different scope.
    """
    if not cursor:
        return None
    try:
        payload = decode_cursor(CURSOR_SEARCH, cursor)
    except CursorError as exc:
        raise SearchInputError(
            "cursor", f"cursor did not decode as a v1 search cursor: {exc}",
        ) from exc
    # decode_cursor already enforces kind, version and the payload's keys
    # and types (archive_cursor.CURSOR_SCHEMAS). A second copy of that
    # rule here is how two behaviours silently diverge.
    # A cursor minted inside one transcript must not be replayed against
    # another: it would scan the wrong rows and report a position that
    # means nothing here.
    if scope == SCOPE_TRANSCRIPT and payload["t_id"] != scope_id:
        raise SearchInputError("cursor", (
            f"cursor names transcript {payload['t_id']} but the scope is "
            f"transcript {scope_id}"))
    return payload


# --- Scope resolution, scan order, snippets --------------------------------


def _scope_size(conn: sqlite3.Connection, scope: str, scope_id: int) -> Optional[int]:
    """Count the transcripts in scope, or report the scope missing.

    Inputs: conn, scope, scope_id. Output: transcripts in scope, or None
      when the id has no row - ``not_found``, NOT an empty result.
    """
    if scope == SCOPE_TRANSCRIPT:
        row = conn.execute(_TRANSCRIPT_ROW_SQL, (scope_id,)).fetchone()
        return None if row is None else 1
    if conn.execute(_PROJECT_EXISTS_SQL, (scope_id,)).fetchone() is None:
        return None  # not_found, never an empty list
    return int(conn.execute(_PROJECT_COUNT_SQL, (scope_id,)).fetchone()[0])


def _run_scan(
    conn: sqlite3.Connection, q: str, scope: str, scope_id: int, limit: int,
    scan_budget: int, scan_bytes: int, case_sensitive: bool,
    resume: Optional[Dict[str, Any]], index: Optional[KnownSecretIndex],
    snippets: bool, filters: BlockFilters, order: str,
) -> Tuple[List[Dict[str, Any]], int, int, str, Optional[Dict[str, Any]]]:
    """Run ONE index query over the whole scope and page its result.

    Description: the per-transcript walk this used to do was measured on
      the real index and it is the wrong shape - re-running the MATCH for
      each transcript cost 945.8 ms for ``tmux`` over 50 transcripts
      against 15.85 ms for the single query. The keyset that used to sit
      in the outer loop is now in the ORDER BY, so the result ORDER and
      the resume CURSOR are unchanged.

      THE BUDGETS ARE NO LONGER REACHABLE HERE AND THE COUNTS SAY SO
      RATHER THAN PRETEND. The index covers every transcript in scope, so
      one query searches all of them: the caller reports
      ``transcripts_scanned == transcripts_in_scope`` and
      ``transcripts_not_scanned == 0``, both measurements. ``bytes_scanned``
      is 0 because no ``body_json`` was read, and ``scan.method`` says
      ``fts_index`` so a reader knows why a real number is zero. The two
      budget arguments are still accepted and still reported, because
      removing a parameter is a shape change; they simply never bind.

      Fetches ``limit + 1`` and DISCARDS the extra: the only ``has_more``
      method that does not lie.
    Inputs: conn, q, scope, scope_id, limit, scan_budget, scan_bytes
      (both inert, see above), case_sensitive, resume, index, snippets,
      filters (BlockFilters), order (ORDER_POSITION | ORDER_RELEVANCE).
    Output: (hits, transcripts_scanned, bytes_scanned, stop_status,
      position); position carries t_ingested_at/t_id/line_no, or None
      when the scope was exhausted.
    Example: _run_scan(conn, "tmux", "project", 1, 50, 1, 1, False, None,
      idx, True, BlockFilters(), ORDER_POSITION)[3] -> 'complete'
    """
    rows = run_hit_query(
        conn, q, scope, scope_id, cap=limit + 1,
        case_sensitive=case_sensitive, filters=filters, resume=resume,
        order=order,
    )
    overflow = len(rows) > limit
    hits = [build_fts_hit(conn, row, q, index, snippets)
            for row in rows[:limit]]
    if overflow:
        last = rows[limit - 1]
        return (hits, 0, 0, SCAN_LIMIT_REACHED,
                {"t_ingested_at": last["ingested_at"],
                 "t_id": int(last["transcript_id"]),
                 "line_no": int(last["line_no"])})
    return hits, 0, 0, SCAN_COMPLETE, None


def _envelope_for(
    q: str, case_sensitive: bool, scope: str, scope_id: int,
    in_scope: Optional[int], result: Any, result_status: str,
    scope_status: str, unevaluated: List[Dict[str, str]],
    scan: Dict[str, Any], paging: Dict[str, Any],
    gate: Optional[Dict[str, Any]] = None,
    index_meta: Optional[Dict[str, Any]] = None,
    coverage_meta: Optional[Dict[str, Any]] = None,
    filters: Optional[BlockFilters] = None,
    order: str = ORDER_POSITION,
) -> Dict[str, Any]:
    """Assemble the envelope. One builder, so no path can omit a block.

    Description: ``index`` and ``coverage`` are NEW meta blocks and they
      answer the two questions an FTS search raises that a substring scan
      did not - is the index usable, and what is it not covering. Both
      are present on EVERY path, refusals included, because a refusal
      that omits them cannot say why it refused.
    Inputs: as the parameter list. index_meta / coverage_meta (dict or
      None) - None renders as "not measured", never as zeros.
    Output: dict - the three-outcome envelope.
    """
    id_key = "project_id" if scope == SCOPE_PROJECT else "transcript_id"
    return envelope(
        result=result, result_status=result_status, scope_status=scope_status,
        unevaluated=unevaluated,
        meta={
            "query": {"q": q, "case_sensitive": bool(case_sensitive),
                      "order": order,
                      "filters": (filters or BlockFilters()).as_meta()},
            "scope": {"kind": scope, id_key: scope_id,
                      "transcripts_in_scope": in_scope},
            "scan": scan, "paging": paging,
            "snippet_gate": gate or snippet_gate_meta(None),
            "index": index_meta or {"state": None, "reason":
                                    "the index was not interrogated"},
            "coverage": coverage_meta or {
                "measured": False, "bodies_indexed": None,
                "bodies_not_indexed": None, "not_indexed_by_reason": None},
            **offset_units_meta(),  # same defn as secrets; cannot drift
        })


def search_scoped(
    conn: sqlite3.Connection,
    q: str,
    scope: str,
    scope_id: int,
    limit: int = DEFAULT_SEARCH_LIMIT,
    scan_budget: int = MAX_SCAN_BUDGET,
    cursor: Optional[str] = None,
    *,
    scan_bytes: int = MAX_SCAN_BYTES,
    case_sensitive: bool = False,
    snippets: bool = True,
    role: Optional[str] = None,
    block_type: Optional[str] = None,
    tool_name: Optional[str] = None,
    is_error: Optional[bool] = None,
    order: str = ORDER_POSITION,
) -> Dict[str, Any]:
    """Literal search inside ONE project or ONE transcript, over MESSAGE TEXT.

    The caller MUST branch on ``result_status`` before rendering an empty
    state: ``ok`` = searched, holds nothing; ``partial`` = a budget ran
    out and ``meta.scan.resume_cursor`` says where to continue;
    ``cannot_determine`` = the question was never evaluated.

    WHAT MOVED. The haystack is now the broken-out content blocks rather
    than the whole jsonl record, so a metadata token no longer matches
    every message that carried it in its envelope: ``claude-opus-4``
    returned 33,805 bodies and now returns the 165 blocks that hold it in
    real message text. The MATCHER is unchanged - still a literal
    substring, still honouring ``case_sensitive`` - only what it runs
    over changed.

    WHAT REFUSES. When the index is ``missing`` or ``never_built`` this
    answers ``cannot_determine`` and names it. It does NOT fall back to
    the old scan: that would silently restore the defect on exactly the
    installs least likely to notice.

    WHAT IS NOT SEARCHABLE, AND SAYS SO. 36.8 percent of bodies carry no
    message text at all (attachments, file-history snapshots, titles),
    and ``meta.coverage`` counts them by reason. An EMPTY result over a
    scope holding any of them adds an ``unevaluated`` entry, so "not
    found", "not indexed" and "never looked at" are three distinguishable
    answers rather than one empty list.

    Inputs: conn (read-only sqlite3.Connection, row_factory Row), q (str,
      2..200 chars), scope ("project"|"transcript"), scope_id (int),
      limit (1..200), scan_budget (accepted and reported, now inert - see
      _run_scan), cursor (opaque or None), scan_bytes (likewise inert),
      case_sensitive, snippets (False returns no preview text at all,
      the only HARD guarantee here; meta.snippet_gate states the rest),
      role / block_type / tool_name / is_error (optional narrowings, each
      None meaning no filter), order ("position" - the default and the
      ordering this endpoint has always had - or "relevance", BM25).
    Output: the three-outcome envelope. ``transcripts_scanned`` equals
      ``transcripts_in_scope`` because one index query covers the scope;
      ``bytes_scanned`` is 0 because no body was read, and
      ``scan.method`` says so.
    Raises: nothing - every defect becomes a ``cannot_determine``
      envelope naming its subject, because a route needs a payload.
    Example: search_scoped(conn, "tmux", "project", 1,
      block_type="tool_use")["meta"]["index"]["state"] -> 'current'
    """
    started = time.perf_counter()
    filters = BlockFilters(
        role=role, block_type=block_type, tool_name=tool_name,
        is_error=is_error,
    )
    #: When no scan ran, every count is None. 0 would be a measurement.
    not_run = {"status": SCAN_NOT_RUN, "method": SCAN_METHOD_FTS,
               "transcripts_scanned": None,
               "transcripts_not_scanned": None, "bytes_scanned": None,
               "budget_transcripts": scan_budget, "budget_bytes": scan_bytes,
               "elapsed_seconds": None, "resume_cursor": None}
    no_paging = {"limit": limit, "returned": 0, "has_more": None,
                 "next_cursor": None}
    index_state = probe_index_state(conn, read_liveness_for(conn))

    def refuse(subject: str, reason: str, res: str, sco: str,
               result: Any) -> Dict[str, Any]:
        return _envelope_for(
            q, case_sensitive, scope, scope_id, None, result, res, sco,
            [{"subject": subject, "reason": reason}], not_run, no_paging,
            index_meta=index_state.to_meta(), filters=filters, order=order)

    try:
        _validate_inputs(q, scope, scope_id, limit, scan_budget, scan_bytes)
        _validate_order(order)
        resume = _decode_resume(cursor, scope, scope_id)
    except SearchInputError as exc:
        bad_scope = exc.subject in ("scope", f"{scope}_id")
        return refuse(exc.subject, exc.reason, RESULT_CANNOT_DETERMINE,
                      SCOPE_CANNOT_DETERMINE if bad_scope else SCOPE_RESOLVED,
                      None)
    # A search the index cannot answer is a cannot_determine, never an
    # empty list. This is checked BEFORE the scope, because "the index is
    # not built" is true whatever project was asked for.
    if not index_state.usable:
        return refuse("index", index_state.reason, RESULT_CANNOT_DETERMINE,
                      SCOPE_RESOLVED, None)
    try:
        in_scope = _scope_size(conn, scope, scope_id)
        if in_scope is None:
            return refuse(f"{scope}:{scope_id}",
                          f"no row in message_{scope}s with id {scope_id}",
                          RESULT_NOT_FOUND, SCOPE_NOT_FOUND, [])
        if not query_is_tokenizable(q):
            return refuse(
                "q",
                f"q holds no alphanumeric character, so the tokenizer "
                f"({BLOCK_SEARCH_TOKENIZER}) produces no term from it and "
                f"the index cannot be asked. The substring scan this "
                f"replaced COULD find such a string; that capability is "
                f"gone and this is the refusal saying so, rather than a "
                f"result of zero.",
                RESULT_CANNOT_DETERMINE, SCOPE_RESOLVED, None)
        index = load_index(conn) if snippets else None
        gate = snippet_gate_meta(index)
        hits, scanned, used, status, position = _run_scan(
            conn, q, scope, scope_id, limit, scan_budget, scan_bytes,
            case_sensitive, resume, index, snippets, filters, order)
        # Measured only on an empty page. See the coverage ladder's own
        # module docstring: 44.16 ms over the largest project here, and a
        # page that returned hits cannot be mistaken for "nothing here".
        coverage = (resolve_coverage(conn, scope, scope_id) if not hits
                    else Coverage(complete=False))
    except sqlite3.Error as exc:
        # Specific, and deliberately not re-raised: a route needs a
        # payload. The message names the operation, never a body value.
        return refuse("datastore",
                      f"sqlite refused the scan: {type(exc).__name__}: {exc}",
                      RESULT_CANNOT_DETERMINE, SCOPE_CANNOT_DETERMINE, None)

    # ONE index query covers every transcript in scope, so the whole scope
    # WAS searched. Both numbers are measurements, and their invariant
    # (scanned + not_scanned == in_scope) still holds.
    total_scanned = in_scope
    not_scanned = 0
    total_bytes = 0
    encoded = None if position is None else encode_cursor(
        CURSOR_SEARCH,
        {"v": CURSOR_VERSION, "scanned": total_scanned,
         "bytes": total_bytes, **position})
    at_limit = status == SCAN_LIMIT_REACHED

    unevaluated: List[Dict[str, str]] = []
    # An EMPTY result over a scope holding unsearchable bodies is the one
    # case where "found nothing" and "could not have found it" look the
    # same, so that is where the coverage refusal is raised. Saying it on
    # every search would make it noise nobody reads.
    if not hits and coverage.complete and coverage.bodies_not_indexed:
        unevaluated.append({
            "subject": f"{scope}:{scope_id}",
            "reason": _coverage_reason(coverage)})
    # The second thing an empty page must be told, and it is about the
    # MATCHER rather than about the corpus. See archive_search_fts's
    # phrase_query for the measured recall this quotes.
    if not hits:
        unevaluated.append({"subject": "q", "reason": (
            f"the index matches whole tokens and prefixes of tokens, so a "
            f"query beginning INSIDE a word cannot be found by it: "
            f"'resize' does not reach 'sendResize'. Measured recall "
            f"against a full substring scan of the same text is 96.7 to "
            f"100 percent over twelve real queries. If {q!r} begins "
            f"mid-word, an empty result here is a limit of the index "
            f"rather than an absence in the corpus.")})
    if index_state.state == INDEX_STALE:
        unevaluated.append({"subject": "index", "reason": index_state.reason})

    return _envelope_for(
        q, case_sensitive, scope, scope_id, in_scope, hits,
        RESULT_OK, SCOPE_RESOLVED, unevaluated,
        {"status": status, "method": SCAN_METHOD_FTS,
         "transcripts_scanned": total_scanned,
         "transcripts_not_scanned": not_scanned, "bytes_scanned": total_bytes,
         "budget_transcripts": scan_budget, "budget_bytes": scan_bytes,
         "elapsed_seconds": round(time.perf_counter() - started, 6),
         # Exactly one of resume_cursor / next_cursor is ever set, and on
         # this path the budget is unreachable so resume_cursor never is.
         "resume_cursor": None},
        {"limit": limit, "returned": len(hits),
         "has_more": bool(at_limit),
         "next_cursor": encoded if at_limit else None},
        gate, index_state.to_meta(), coverage.to_meta(), filters, order)


def _coverage_reason(coverage: Coverage) -> str:
    """Word the refusal an empty result over unindexed bodies earns.

    Description: names the COUNT and the REASONS, because "some content
      is not searchable" is not actionable and "79,667 bodies carry no
      message text" is.
    Inputs: coverage (Coverage) - must be ``complete``.
    Output: str.
    Example: _coverage_reason(cov) -> '3 of 10 bodies in scope are not ...'
    """
    parts = ", ".join(
        f"{count} {reason}" for reason, count in sorted(coverage.by_reason.items())
        if reason != COVERAGE_INDEXED)
    total = coverage.bodies_indexed + coverage.bodies_not_indexed
    return (
        f"{coverage.bodies_not_indexed} of {total} bodies in scope are not in "
        f"the search index and could not have matched ({parts}). "
        f"An empty result here means NOT FOUND IN INDEXED TEXT, which is "
        f"not the same as not present in this scope."
    )


def _validate_order(order: str) -> None:
    """Refuse an unknown ordering rather than silently using the default.

    Description: a typo'd order that silently fell back would return a
      correct-looking page in the wrong order, which is the kind of wrong
      nobody reports.
    Inputs: order (str).
    Output: None.
    Raises: SearchInputError.
    Example: _validate_order("relevance")
    """
    if order not in ORDER_MODES:
        raise SearchInputError(
            "order",
            f"order must be one of {list(ORDER_MODES)}; got {order!r}")


def read_liveness_for(conn: sqlite3.Connection) -> Optional[Dict[str, Any]]:
    """Read the index build record for the database this connection holds.

    Description: the artifact lives beside the database file, so its
      directory is derived from the connection rather than from settings
      - a test pointing at a throwaway datastore then reads that
      datastore's own record instead of the developer's.
    Inputs: conn (sqlite3.Connection).
    Output: dict or None - None when there is no record, which is a
      different fact from a record saying a build failed.
    Example: read_liveness_for(conn) -> {"outcome": "built", ...}
    """
    try:
        row = conn.execute("PRAGMA database_list").fetchone()
    except sqlite3.Error:
        # Specific: a connection that cannot name its own file still has
        # to be searchable. The record is a DECORATION on the verdict and
        # its absence renders as "no build recorded".
        return None
    if row is None or not row[2]:
        return None
    return read_liveness(Path(row[2]).parent)
