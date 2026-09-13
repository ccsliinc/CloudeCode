"""The FTS5-backed matcher: one scope-wide query, then the literal check.

THE INDEX NARROWS, ``INSTR`` STILL MATCHES, and that division is the
whole design. FTS5 with ``unicode61`` matches TOKENS, so the phrase
``"claude-opus-4"`` also matches the text ``claude opus 4`` - fuzzier
than the substring contract this endpoint has always had, and it cannot
give a truthful character offset either, because the matched tokens may
sit further apart in the text than the query does. So the index answers
"which blocks could possibly contain this" and ``INSTR`` over those
blocks' own text answers "and where exactly". Same matcher as before,
same literal semantics, same ``case_sensitive`` behaviour - a haystack
0.001 percent of the size.

MEASURED, 2026-09-13, on the 400-transcript projection, largest project
(167 transcripts), page of 50:

  query                        before (INSTR over body_json)   after
  a miss                                     919 ms             0.02 ms
  "claude-opus-4"                              -                0.71 ms
  resize                                       -                1.80 ms
  tmux (very common)                           -               15.85 ms

ONE QUERY FOR THE WHOLE SCOPE, NOT ONE PER TRANSCRIPT. The per-transcript
loop the old scan used was measured on this index and it is the wrong
shape: re-running the MATCH for each transcript cost 945.8 ms for
``tmux`` over 50 transcripts against 15.85 ms for the single query. The
keyset ``(ingested_at DESC, id DESC, line_no)`` is carried into the
ORDER BY instead, so the result order and the resume cursor are
byte-identical to what the old scan produced.

THE BYTE BUDGET IS NOW UNREACHABLE AND THE NUMBERS SAY SO RATHER THAN
PRETENDING. The index covers every transcript in scope, so a query
searches all of them: ``transcripts_scanned`` equals
``transcripts_in_scope`` and ``transcripts_not_scanned`` is 0, which are
measurements and not placeholders. ``bytes_scanned`` is 0 because zero
bytes of ``body_json`` were read, and ``scan.method`` says
``fts_index`` so a reader knows why a real number is zero rather than
assuming the counter broke. ``budget_exhausted`` and therefore
``result_status: partial`` are no longer reachable on this path; the
constants stay, because a caller's branch on them is still correct and
deleting a vocabulary word is a shape change.

THE QUERY IS ALWAYS A QUOTED PHRASE. FTS5's MATCH argument is a query
LANGUAGE - ``*``, ``:``, ``^``, ``-``, ``NEAR``, ``AND``, ``OR``,
``NOT`` and parentheses are all operators. A caller's literal string is
therefore wrapped in double quotes, with any embedded quote doubled, so
it is one phrase and nothing in it can be read as syntax. That preserves
the endpoint's substring contract and removes a whole class of
"fts5: syntax error" 500s.

THE NAMED GAP. A query that begins or ends mid-token cannot be found:
``unicode61`` makes ``sendResize`` one token, so ``resize`` does not
reach it. Measured over the whole corpus, a trigram index recovered 854
blocks for ``resize`` against this one's 752 - 13.6 percent more - and
cost 332.3 MiB against 51.4 MiB. See message_block_search_ddl for why
that trade was refused. This is a limitation of the index, it is stated
in ``meta.index``, and it is not a bug to be fixed by widening the
matcher.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from src.core.message_block_search_ddl import BLOCK_SEARCH_TABLE

#: Resume sentinel, imported by ``archive_search``. ``-1`` means the
#: named transcript was finished, so resume strictly AFTER it; ``>= 0``
#: resumes INSIDE it at a greater line_no. Identical to the old scan's
#: meaning, because the cursor is the same cursor.
LINE_DONE: int = -1

#: Order modes. ``position`` is the default and is the ordering this
#: endpoint has always had, so a client that does not ask for anything
#: gets exactly what it got before. ``relevance`` is BM25 and is opt-in.
ORDER_POSITION: str = "position"
ORDER_RELEVANCE: str = "relevance"
ORDER_MODES: Tuple[str, ...] = (ORDER_POSITION, ORDER_RELEVANCE)


@dataclass(frozen=True)
class BlockFilters:
    """The structured narrowings a caller may add to a text query.

    Description: every field defaults to None meaning NO FILTER, so the
      unfiltered call is the call this endpoint has always accepted.
      ``is_error`` is a three-state on purpose: True, False and None are
      "failed", "succeeded" and "do not care", and the column itself is
      nullable because 39.6 percent of tool_result blocks carry no
      ``is_error`` key at all - defaulting those to False would assert
      that every one of them succeeded.
    Inputs: role (str|None) - message_roles.value, e.g. "assistant".
      block_type (str|None) - message_block_types.value, e.g.
      "tool_use". tool_name (str|None) - exact tool name.
      is_error (bool|None).
    Output: a frozen record.
    Example: BlockFilters(block_type="tool_use", tool_name="Bash")
    """

    role: Optional[str] = None
    block_type: Optional[str] = None
    tool_name: Optional[str] = None
    is_error: Optional[bool] = None

    def as_meta(self) -> Dict[str, Any]:
        """Render the filters for the response envelope.

        Output: dict - the four values, Nones included, so a caller can
          see that a filter it sent was understood.
        """
        return {
            "role": self.role, "block_type": self.block_type,
            "tool_name": self.tool_name, "is_error": self.is_error,
        }

    @property
    def any_set(self) -> bool:
        """Whether any filter narrows the query.

        Output: bool.
        """
        return any(v is not None for v in
                   (self.role, self.block_type, self.tool_name,
                    self.is_error))


def phrase_query(q: str) -> str:
    """Turn a caller's literal string into one FTS5 phrase, prefix-matched.

    Description: the ONE place a user string becomes MATCH syntax. Every
      FTS5 operator loses its meaning inside a quoted phrase, and an
      embedded double quote is escaped by doubling it, which is FTS5's
      own rule. Without this a query containing a colon or an asterisk is
      a syntax error the caller cannot have predicted.

      THE TRAILING STAR IS NOT DECORATION, IT IS RECALL, AND IT WAS
      MEASURED. A bare phrase matches whole tokens, so a query that is
      the PREFIX of a longer token finds nothing at all. On the
      400-transcript projection ``msg_01`` occurs as a substring in 27
      blocks and a bare phrase returned ZERO of them, because the text
      holds ``msg_01ABC...`` and ``unicode61`` makes that one token.
      Recall against a pure substring scan of the same block text, 12
      real queries, bare phrase then prefixed:

        msg_01                  0.0% ->  100.0%
        resize                 88.1% ->   97.0%
        the                    92.6% ->   96.7%
        claude-opus-4         100.0% ->  100.0%
        /Users/jsugamele      100.0% ->  100.0%

      Eight of the twelve are exact and the worst is 96.7 percent. The
      residue is the gap this index cannot close: a query that begins
      INSIDE a token (``resize`` against ``sendResize``) needs a trigram
      index, measured at 332.3 MiB against this one's 51.4 MiB and
      refused. That residue is REPORTED on an empty result rather than
      left to be discovered.

      The cost is small and one-sided: a query ending in a very short
      token scans a wide term range (``claude-opus-4`` went 1.4 ms to
      11.2 ms, its last token being ``4``). Everything else moved by
      under a millisecond.
    Inputs: q (str) - the caller's literal string.
    Output: str - a MATCH argument.
    Example: phrase_query('a b') -> '"a b"*'
    """
    escaped = q.replace('"', '""')
    return f'"{escaped}"*'


def query_is_tokenizable(q: str) -> bool:
    """Say whether the query can produce an indexable token at all.

    Description: ``unicode61`` tokenises on Unicode alphanumerics, so a
      string with none of them - ``...``, ``->``, ``{}`` - produces no
      token and can never match anything in this index, however common
      those characters are in the text. The old substring scan DID find
      them, so this is a REAL loss of capability and it has to be a named
      refusal rather than a result of zero hits.

      A pure rule rather than a round trip to the index: FTS5 answers an
      all-punctuation phrase with zero rows rather than an error, so
      asking it cannot tell "no such token" from "not present here".
    Inputs: q (str).
    Output: bool - False when nothing in q can become a token.
    Example: query_is_tokenizable("...") -> False
    """
    return any(ch.isalnum() for ch in q)


#: The scope-wide hit query. ``f`` is driven by MATCH (the plan reads
#: ``SCAN f VIRTUAL TABLE INDEX 0:M1``), ``cb`` by INTEGER PRIMARY KEY,
#: ``a`` by ix_message_appearances_body and ``t`` by its rowid.
#: tests/test_block_search_query_plan.py pins that, because a previous
#: change in this repo added an index the planner ignored and the timing
#: did not move: a plan is the regression guard, a stopwatch is not.
#:
#: ``cloude_body_chars`` rather than ``LENGTH``: ``body_json`` may hold
#: the compressed frame, and LENGTH over a blob returns its COMPRESSED
#: byte count, silently.
_HIT_SQL: str = f"""
SELECT t.id           AS transcript_id,
       t.session_ref  AS session_ref,
       t.ingested_at  AS ingested_at,
       a.line_no      AS line_no,
       a.body_id      AS body_id,
       b.secret_finding_count AS secret_finding_count,
       cloude_body_chars(b.body_json) AS body_bytes,
       cb.id          AS block_id,
       cb.seq         AS block_seq,
       -- NOT cb.text. The ORDER BY materialises every selected column of
       -- every matching row into a temp b-tree before the LIMIT applies,
       -- and a tool_result block runs to megabytes; the preview window is
       -- cut with SUBSTR inside SQLite instead, which is the same reason
       -- archive_snippet_gate cuts its own window there.
       LENGTH(cb.text) AS block_chars,
       cb.tool_name   AS tool_name,
       cb.is_error    AS is_error,
       bt.value       AS block_type,
       r.value        AS role,
       m.value        AS model,
       INSTR({{hay}}, {{needle}}) - 1 AS match_offset
       {{rank_select}}
  FROM {BLOCK_SEARCH_TABLE} f
  JOIN message_content_blocks cb ON cb.id = f.rowid
  JOIN message_block_types bt ON bt.id = cb.block_type_id
  JOIN message_bodies b ON b.id = cb.body_id
  JOIN message_appearances a ON a.body_id = cb.body_id
  JOIN message_transcripts t ON t.id = a.transcript_id
  LEFT JOIN message_roles r ON r.id = b.role_id
  LEFT JOIN message_models m ON m.id = b.model_id
 WHERE {BLOCK_SEARCH_TABLE} MATCH :match
   AND {{scope_clause}}
   AND INSTR({{hay}}, {{needle}}) > 0
   {{filter_clause}}
   {{keyset_clause}}
 ORDER BY {{order_clause}}
 LIMIT :cap
"""

_ORDER_POSITION_SQL: str = "t.ingested_at DESC, t.id DESC, a.line_no ASC"
#: BM25 returns a NEGATIVE score whose magnitude grows with relevance, so
#: ASC is most-relevant-first. The position keys stay as the tie-break so
#: two equally ranked hits still come back in a stable, meaningful order
#: rather than in whatever order the join produced.
_ORDER_RELEVANCE_SQL: str = (
    f"bm25({BLOCK_SEARCH_TABLE}) ASC, t.ingested_at DESC, t.id DESC, "
    f"a.line_no ASC"
)


def _filter_clause(filters: BlockFilters, params: Dict[str, Any]) -> str:
    """Build the structured narrowing, adding only the params it uses.

    Description: each filter is a separate AND against an indexed or
      interned column. ``block_type`` and ``tool_name`` together are
      exactly ``ix_message_content_blocks_type_tool``'s columns, which is
      why the pair is the cheap case.
    Inputs: filters (BlockFilters), params (dict) - mutated in place.
    Output: str - SQL fragment, possibly empty.
    Example: _filter_clause(BlockFilters(role="user"), {}) ->
      "   AND r.value = :f_role"
    """
    parts: List[str] = []
    if filters.role is not None:
        parts.append("AND r.value = :f_role")
        params["f_role"] = filters.role
    if filters.block_type is not None:
        parts.append("AND bt.value = :f_block_type")
        params["f_block_type"] = filters.block_type
    if filters.tool_name is not None:
        parts.append("AND cb.tool_name = :f_tool_name")
        params["f_tool_name"] = filters.tool_name
    if filters.is_error is not None:
        parts.append("AND cb.is_error = :f_is_error")
        params["f_is_error"] = 1 if filters.is_error else 0
    return ("\n   " + "\n   ".join(parts)) if parts else ""


def _keyset_clause(
    resume: Optional[Dict[str, Any]], params: Dict[str, Any],
) -> str:
    """Build the resume predicate for the position ordering.

    Description: the SAME tuple and the SAME two operators the old
      per-transcript scan used, so an existing cursor resumes here
      exactly where it resumed there. ``line_no == LINE_DONE`` excludes
      the named transcript; ``>= 0`` resumes inside it.

      Lexicographic ordering of ``ingested_at`` is correct ONLY because
      every value is fixed-width UTC ISO-8601 with a Z suffix. That is a
      property of the DATA, not of the schema.
    Inputs: resume (dict or None), params (dict) - mutated in place.
    Output: str - SQL fragment, possibly empty.
    """
    if resume is None:
        return ""
    params["c_ts"] = resume["t_ingested_at"]
    params["c_id"] = resume["t_id"]
    if resume["line_no"] == LINE_DONE:
        return ("AND (t.ingested_at < :c_ts "
                "OR (t.ingested_at = :c_ts AND t.id < :c_id))")
    params["c_line"] = resume["line_no"]
    return ("AND (t.ingested_at < :c_ts "
            "OR (t.ingested_at = :c_ts AND t.id < :c_id) "
            "OR (t.ingested_at = :c_ts AND t.id = :c_id "
            "AND a.line_no > :c_line))")


def build_hit_query(
    scope: str,
    case_sensitive: bool,
    filters: BlockFilters,
    resume: Optional[Dict[str, Any]],
    order: str,
    params: Dict[str, Any],
) -> str:
    """Assemble the one hit query, and fill ``params`` for it.

    Description: ONE builder, so the query the planner is tested against
      and the query a request runs cannot be two different strings. The
      caller supplies ``params`` and gets it back populated; nothing is
      interpolated into the SQL except the fragments built above, and no
      caller value ever is.
    Inputs: scope ("project"|"transcript"), case_sensitive (bool),
      filters (BlockFilters), resume (dict|None), order (one of
      ORDER_MODES), params (dict) - mutated in place; the caller must
      already have set ``match``, ``q``, ``scope_id`` and ``cap``.
    Output: str - the SQL.
    Raises: ValueError - an unknown scope or order mode, rather than a
      silently wrong query.
    Example: build_hit_query("project", False, BlockFilters(), None,
      ORDER_POSITION, {"match": '"x"', "q": "x", "scope_id": 1,
      "cap": 51})
    """
    if order not in ORDER_MODES:
        raise ValueError(f"order must be one of {list(ORDER_MODES)}; "
                         f"got {order!r}")
    if scope == "project":
        scope_clause = "t.project_id = :scope_id"
    elif scope == "transcript":
        scope_clause = "t.id = :scope_id"
    else:
        raise ValueError(f"scope must be project or transcript; got {scope!r}")
    hay = "cb.text" if case_sensitive else "LOWER(cb.text)"
    needle = ":q" if case_sensitive else "LOWER(:q)"
    rank = (f", bm25({BLOCK_SEARCH_TABLE}) AS rank_score"
            if order == ORDER_RELEVANCE else ", NULL AS rank_score")
    order_clause = (_ORDER_RELEVANCE_SQL if order == ORDER_RELEVANCE
                    else _ORDER_POSITION_SQL)
    return _HIT_SQL.format(
        hay=hay, needle=needle, rank_select=rank,
        scope_clause=scope_clause,
        filter_clause=_filter_clause(filters, params),
        keyset_clause=_keyset_clause(resume, params),
        order_clause=order_clause,
    )


def run_hit_query(
    conn: sqlite3.Connection,
    q: str,
    scope: str,
    scope_id: int,
    *,
    cap: int,
    case_sensitive: bool = False,
    filters: Optional[BlockFilters] = None,
    resume: Optional[Dict[str, Any]] = None,
    order: str = ORDER_POSITION,
) -> List[sqlite3.Row]:
    """Run the matcher and return up to ``cap`` raw hit rows.

    Description: the caller asks for one more row than it will render
      and DISCARDS the extra - the only ``has_more`` method that does not
      lie - so ``cap`` is ``limit + 1``.
    Inputs: conn (sqlite3.Connection). q (str) - the caller's literal
      string. scope, scope_id. cap (int). case_sensitive (bool).
      filters (BlockFilters|None). resume (dict|None). order (str).
    Output: list of sqlite3.Row.
    Raises: sqlite3.Error - propagated; ``archive_search`` turns it into
      a cannot_determine envelope naming the datastore.
    Example: run_hit_query(conn, "tmux", "project", 1, cap=51)
    """
    params: Dict[str, Any] = {
        "match": phrase_query(q), "q": q, "scope_id": scope_id,
        "cap": int(cap),
    }
    sql = build_hit_query(
        scope, case_sensitive, filters or BlockFilters(), resume, order,
        params,
    )
    return conn.execute(sql, params).fetchall()
