"""Two ladders: is the index usable, and what does it not cover.

They are SEPARATE QUESTIONS and folding them into one boolean is how a
search comes to render "no results" for three different reasons.

LADDER ONE, THE INDEX. Five states, built on the same four-word
vocabulary ``corpus_ingest_state`` and ``db_integrity_status`` already
use, plus one this path needed:

  ``missing``      the FTS table is not there. An install that has not
                   reached v27, or one whose archive flag is off.
  ``never_built``  the table exists and holds nothing while blocks
                   exist. The migration CREATES and does not POPULATE,
                   so this is the normal state of a freshly migrated
                   install, and it is a REFUSAL rather than zero hits.
  ``present``      the table holds rows and NOBODY COUNTED whether it
                   covers all of them. See INDEX_PRESENT below: counting
                   costs 37 ms against a 0.07 ms query, so the request
                   path does not, and says it did not.
  ``stale``        the counts were taken and disagree. Hits are still
                   returned, with the discrepancy named, because a
                   partly built index answering some questions beats
                   refusing all of them.
  ``current``      the counts were taken and agree.

``missing`` AND ``never_built`` REFUSE; the other three answer. Falling
back to the old ``INSTR(body_json, ...)`` scan was considered and
rejected outright: it would silently restore the 33,805-hit
false-positive defect the index exists to fix, on exactly the installs
least likely to notice.

THE COUNT COMPARISON IS THE MEASUREMENT AND THE LIVENESS FILE IS NOT. A
record saying a build succeeded, over an index that is empty, is a record
that is wrong. So a verdict is only ever taken from the counts; the
record contributes its timestamp, which is what an operator needs to know
how old a ``stale`` is. There are TWO entry points and they differ only
in whether they pay for counting: :func:`probe_index_state` for a
request, :func:`resolve_index_state` for a status route or a rebuild.

LADDER TWO, COVERAGE, AND IT IS THE 37 PERCENT. Measured on the
400-transcript projection, 2026-09-13, over 216,716 bodies:

  blocks_extracted      129,796   indexed
  content_string          7,253   indexed
  no_message_content     79,667   NOT INDEXED, correctly - attachments,
                                  file-history snapshots, titles. They
                                  carry no message text at all, and what
                                  the old INSTR search found in them was
                                  purely envelope metadata.

36.8 percent of bodies are therefore unsearchable, and they SHOULD be.
The defect would be for that to look like "not found". So an EMPTY result
set over a scope holding unindexed bodies carries the breakdown AND a
named entry in the envelope's ``unevaluated`` list - the field the
three-outcome contract already says a caller must branch on before
rendering an empty state.

IT IS MEASURED ON AN EMPTY PAGE ONLY, and that is a cost decision stated
rather than hidden. The pass is 44.16 ms over the largest project here
and 3.62 ms over one transcript; a page that RETURNED hits cannot be
mistaken for "there is nothing here", so it is the page that returned
NOTHING that needs the answer. On any other page ``coverage.measured`` is
False and says why - which is the truth, and is not the same as claiming
everything was indexed.

THE FOUR NOT-INDEXED REASONS ARE NOT INTERCHANGEABLE, and the last one
is the one that matters most:

  ``no_message_content``   measured: legitimately carries no text
  ``could_not_evaluate``   unparseable_body / unexpected_content_shape
  ``never_processed``      NO ROW in message_body_block_status at all.
                           The extractor has not looked at this body. The
                           search result is INCOMPLETE, not empty.
  ``no_text_projected``    the body has blocks and none of them carries
                           text: images and documents, whose payload is
                           bytes and is deliberately not projected.

"not found", "not indexed" and "never looked" are three different
answers and a user is entitled to know which one they got.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from src.core.message_block_ddl import (
    STATUS_BLOCKS_EXTRACTED,
    STATUS_CONTENT_STRING,
    STATUS_NO_MESSAGE_CONTENT,
)
from src.core.message_block_search_ddl import BLOCK_SEARCH_TABLE

INDEX_MISSING: str = "missing"
INDEX_NEVER_BUILT: str = "never_built"
INDEX_STALE: str = "stale"
INDEX_CURRENT: str = "current"

#: The FIFTH state, and it exists because counting is not free. Measured
#: on the 400-transcript projection: the two COUNT(*) queries behind
#: ``current`` versus ``stale`` cost 37.08 ms, on a search whose own
#: index query costs 0.07 ms for a miss. Paying 37 ms per request to
#: decide between two states that are BOTH usable is the shape of defect
#: this project keeps paying for, so the search path takes
#: :func:`probe_index_state` and gets ``present``: the index has rows,
#: and whether it covers every block WAS NOT MEASURED HERE. A reading
#: that did not happen is not a reading of nothing, so this is its own
#: word rather than an optimistic ``current``.
INDEX_PRESENT: str = "present"

#: The states a search may answer hits from. Spelled once so a route,
#: the search itself and a test cannot disagree about it.
INDEX_USABLE: frozenset = frozenset(
    {INDEX_CURRENT, INDEX_STALE, INDEX_PRESENT}
)

COVERAGE_INDEXED: str = "indexed"
COVERAGE_NO_MESSAGE_CONTENT: str = "no_message_content"
COVERAGE_COULD_NOT_EVALUATE: str = "could_not_evaluate"
COVERAGE_NEVER_PROCESSED: str = "never_processed"
COVERAGE_NO_TEXT_PROJECTED: str = "no_text_projected"


@dataclass(frozen=True)
class IndexState:
    """The usability verdict for the block-search index.

    Description: ``state`` is the ladder's answer, ``reason`` is the
      sentence a human reads, and the counts are what produced it, so a
      reader can re-derive the verdict rather than trust it.
    Inputs: constructed by :func:`resolve_index_state`.
    Output: a frozen record.
    """

    state: str
    reason: str
    indexed_rows: Optional[int] = None
    block_rows: Optional[int] = None
    built_at: Optional[str] = None

    @property
    def usable(self) -> bool:
        """Whether a search may return hits from this index.

        Output: bool - True for every state except ``missing`` and
          ``never_built``.
        """
        return self.state in INDEX_USABLE

    def to_meta(self) -> Dict[str, Any]:
        """Render this verdict for a response envelope's ``meta``.

        Output: dict - state, reason, and the two counts behind it.
        Example: resolve_index_state(conn).to_meta()["state"]
        """
        return {
            "state": self.state,
            "reason": self.reason,
            "indexed_rows": self.indexed_rows,
            "indexable_block_rows": self.block_rows,
            "built_at": self.built_at,
        }


@dataclass(frozen=True)
class Coverage:
    """What a scope's bodies are, searchable and otherwise.

    Description: counts by the reason a body is or is not in the index.
      ``complete`` is False when the counts could not be taken at all,
      which is a THIRD thing from every count being zero - the same
      discipline ``StatusMap.complete`` carries.
    Inputs: constructed by :func:`resolve_coverage`.
    Output: a frozen record.
    """

    complete: bool
    by_reason: Dict[str, int] = field(default_factory=dict)

    @property
    def bodies_indexed(self) -> int:
        """How many bodies in scope have searchable text.

        Output: int - 0 when the counts could not be taken.
        """
        return int(self.by_reason.get(COVERAGE_INDEXED, 0))

    @property
    def bodies_not_indexed(self) -> int:
        """How many bodies in scope are outside the index, for any reason.

        Output: int - 0 when the counts could not be taken.
        """
        return sum(
            count for reason, count in self.by_reason.items()
            if reason != COVERAGE_INDEXED
        )

    def to_meta(self) -> Dict[str, Any]:
        """Render coverage for a response envelope's ``meta``.

        Output: dict - ``measured`` plus the per-reason counts. When the
          counts could not be taken every field is None, never 0,
          because 0 is a measurement.
        Example: resolve_coverage(conn, 'project', 1).to_meta()
        """
        if not self.complete:
            return {
                "measured": False,
                "bodies_indexed": None,
                "bodies_not_indexed": None,
                "not_indexed_by_reason": None,
            }
        return {
            "measured": True,
            "bodies_indexed": self.bodies_indexed,
            "bodies_not_indexed": self.bodies_not_indexed,
            "not_indexed_by_reason": {
                reason: count
                for reason, count in sorted(self.by_reason.items())
                if reason != COVERAGE_INDEXED
            },
        }


def index_table_exists(conn: sqlite3.Connection) -> bool:
    """Say whether the FTS5 table has been created.

    Inputs: conn (sqlite3.Connection).
    Output: bool.
    Example: index_table_exists(conn) -> True
    """
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (BLOCK_SEARCH_TABLE,),
    ).fetchone()
    return row is not None


#: Blocks that SHOULD be in the index: text present and not empty. This
#: is the same condition the INSERT trigger carries, spelled once, so the
#: count it produces and the rows the trigger writes cannot disagree.
INDEXABLE_BLOCKS_SQL: str = (
    "SELECT COUNT(*) FROM message_content_blocks "
    "WHERE text IS NOT NULL AND text <> ''"
)


#: Existence probes. ``LIMIT 1`` against a rowid-ordered table is an
#: O(1) seek where COUNT(*) is a full traversal; these are what make the
#: search path's verdict cost nothing measurable.
_ANY_INDEXED_SQL: str = f"SELECT 1 FROM {BLOCK_SEARCH_TABLE} LIMIT 1"
_ANY_INDEXABLE_SQL: str = (
    "SELECT 1 FROM message_content_blocks "
    "WHERE text IS NOT NULL AND text <> '' LIMIT 1"
)


def probe_index_state(
    conn: sqlite3.Connection, liveness: Optional[Dict[str, Any]] = None,
) -> IndexState:
    """Decide usability WITHOUT counting, for the request path.

    Description: three rungs - ``missing``, ``never_built``, and
      ``present`` - resolved by two existence probes rather than two
      COUNT(*) traversals. It CANNOT answer ``current`` or ``stale``,
      and it does not pretend to: ``present`` says the index has rows and
      says its coverage was not measured here. :func:`resolve_index_state`
      is the one that counts, and it belongs on a status route or a
      rebuild, where 37 ms is affordable and a request is not.
    Inputs: conn (sqlite3.Connection). liveness (dict|None) - contributes
      only the build timestamp.
    Output: IndexState with ``indexed_rows`` and ``block_rows`` None,
      because they were not counted and 0 would be a measurement.
    Raises: nothing - a sqlite error becomes ``missing`` with the error
      named, because a table this code cannot interrogate is one it may
      not search.
    Example: probe_index_state(conn).state -> 'present'
    """
    built_at = _built_at(liveness)
    try:
        if not index_table_exists(conn):
            return IndexState(
                INDEX_MISSING,
                f"{BLOCK_SEARCH_TABLE} does not exist; this install has not "
                f"reached schema v27, or the message archive is off",
                built_at=built_at,
            )
        has_rows = conn.execute(_ANY_INDEXED_SQL).fetchone() is not None
        has_work = conn.execute(_ANY_INDEXABLE_SQL).fetchone() is not None
    except sqlite3.Error as exc:
        return IndexState(
            INDEX_MISSING,
            f"the block-search index could not be interrogated: "
            f"{type(exc).__name__}: {exc}",
            built_at=built_at,
        )
    if not has_rows and has_work:
        return IndexState(
            INDEX_NEVER_BUILT,
            "the index holds no rows while content blocks carry text; it is "
            "created by the migration and populated by "
            "scripts/rebuild_block_search_index.py, which has not run here",
            built_at=built_at,
        )
    return IndexState(
        INDEX_PRESENT,
        "the index holds rows; whether it covers every content block was "
        "not measured on this request, because counting both sides costs "
        "37 ms against a 0.07 ms query. GET /api/v1/archive/search/index "
        "takes that measurement.",
        built_at=built_at,
    )


def _built_at(liveness: Optional[Dict[str, Any]]) -> Optional[str]:
    """Pull the build timestamp out of a liveness record, or None.

    Inputs: liveness (dict|None). Output: str or None.
    """
    if isinstance(liveness, dict):
        value = liveness.get("finished_at")
        return value if isinstance(value, str) else None
    return None


def resolve_index_state(
    conn: sqlite3.Connection, liveness: Optional[Dict[str, Any]] = None,
) -> IndexState:
    """Decide whether the block-search index may be searched.

    Description: the ladder in this module's docstring, in order. The
      verdict comes from the COUNTS; ``liveness`` contributes only the
      timestamp a human needs to judge how old a ``stale`` is, and a
      record that disagrees with the counts loses.
    Inputs: conn (sqlite3.Connection, read is enough). liveness (dict or
      None) - the record from ``message_block_search_state.read_liveness``.
    Output: IndexState.
    Raises: nothing - a sqlite error becomes ``missing`` with the error
      named, because a table this code cannot interrogate is a table it
      may not search.
    Example: resolve_index_state(conn).usable -> True
    """
    built_at = _built_at(liveness)
    try:
        if not index_table_exists(conn):
            return IndexState(
                INDEX_MISSING,
                f"{BLOCK_SEARCH_TABLE} does not exist; this install has not "
                f"reached schema v27, or the message archive is off",
                built_at=built_at,
            )
        indexed = int(conn.execute(
            f"SELECT COUNT(*) FROM {BLOCK_SEARCH_TABLE}"
        ).fetchone()[0])
        blocks = int(conn.execute(INDEXABLE_BLOCKS_SQL).fetchone()[0])
    except sqlite3.Error as exc:
        return IndexState(
            INDEX_MISSING,
            f"the block-search index could not be interrogated: "
            f"{type(exc).__name__}: {exc}",
            built_at=built_at,
        )
    if indexed == 0 and blocks > 0:
        return IndexState(
            INDEX_NEVER_BUILT,
            f"the index holds no rows while {blocks} content blocks carry "
            f"text; it is created by the migration and populated by "
            f"scripts/rebuild_block_search_index.py, which has not run here",
            indexed, blocks, built_at,
        )
    if indexed != blocks:
        return IndexState(
            INDEX_STALE,
            f"the index holds {indexed} rows against {blocks} content blocks "
            f"carrying text; hits below are real and the set may be "
            f"incomplete",
            indexed, blocks, built_at,
        )
    return IndexState(
        INDEX_CURRENT,
        f"the index holds {indexed} rows, one per content block carrying "
        f"text",
        indexed, blocks, built_at,
    )


#: One pass over the bodies a scope reaches, bucketed by why each is or
#: is not searchable. The LEFT JOIN is what makes ``never_processed``
#: visible: a body with no status row produces a NULL status, which is a
#: different fact from a status that says there was nothing to extract.
_COVERAGE_SQL: str = """
SELECT CASE
         WHEN s.status IS NULL THEN :never_processed
         WHEN s.status IN (:extracted, :string_content) THEN
           CASE WHEN EXISTS (
                  SELECT 1 FROM message_content_blocks cb
                   WHERE cb.body_id = b.id
                     AND cb.text IS NOT NULL AND cb.text <> ''
                ) THEN :indexed ELSE :no_text END
         WHEN s.status = :no_message THEN :no_message
         ELSE :could_not_evaluate
       END AS reason,
       COUNT(*) AS n
  FROM (SELECT DISTINCT a.body_id AS id
          FROM message_appearances a
          JOIN message_transcripts t ON t.id = a.transcript_id
         WHERE a.body_id IS NOT NULL AND {scope_clause}) b
  LEFT JOIN message_body_block_status s ON s.body_id = b.id
 GROUP BY reason
"""


def resolve_coverage(
    conn: sqlite3.Connection, scope: str, scope_id: int,
) -> Coverage:
    """Count the bodies a scope reaches, by whether they are searchable.

    Description: answers the "not found versus not indexed versus never
      looked" question for ONE search, over exactly the transcripts that
      search covers. Deliberately a separate pass from the search itself:
      an FTS query knows only about rows that are IN the index, so it can
      never report what is missing from it.
    Inputs: conn (sqlite3.Connection). scope ("project" | "transcript").
      scope_id (int).
    Output: Coverage - ``complete`` False when the query could not run,
      which a caller must not read as "everything is indexed".
    Example: resolve_coverage(conn, "transcript", 7).bodies_not_indexed
    """
    clause = ("t.project_id = :scope_id" if scope == "project"
              else "t.id = :scope_id")
    params: Dict[str, Any] = {
        "scope_id": scope_id,
        "never_processed": COVERAGE_NEVER_PROCESSED,
        "extracted": STATUS_BLOCKS_EXTRACTED,
        "string_content": STATUS_CONTENT_STRING,
        "indexed": COVERAGE_INDEXED,
        "no_text": COVERAGE_NO_TEXT_PROJECTED,
        "no_message": STATUS_NO_MESSAGE_CONTENT,
        "could_not_evaluate": COVERAGE_COULD_NOT_EVALUATE,
    }
    try:
        rows = conn.execute(
            _COVERAGE_SQL.format(scope_clause=clause), params,
        ).fetchall()
    except sqlite3.Error:
        # Specific, and deliberately not re-raised: coverage is a
        # DECORATION on a search that otherwise worked, and a missing
        # decoration must not take the search down with it. complete
        # stays False, which renders as "not measured" rather than as
        # "nothing is unindexed".
        return Coverage(complete=False)
    return Coverage(
        complete=True,
        by_reason={str(row[0]): int(row[1]) for row in rows},
    )


#: The statuses that mean the extractor looked and legitimately found no
#: text. Re-exported so a caller does not import from two modules to ask
#: one question.
NOT_INDEXED_BUT_MEASURED: frozenset = frozenset(
    {COVERAGE_NO_MESSAGE_CONTENT, COVERAGE_NO_TEXT_PROJECTED}
)

#: The statuses that mean the answer is genuinely incomplete.
NOT_INDEXED_AND_UNMEASURED: frozenset = frozenset(
    {COVERAGE_NEVER_PROCESSED, COVERAGE_COULD_NOT_EVALUATE}
)
