"""Assemble the search envelope. ONE builder, so no path can omit a block.

WHY IT IS NOT IN ``archive_search.py``. That module was already at the
repo's 500-line guideline before the matcher moved, and this is the part
of it with no logic in it at all - it takes what the ladder decided and
lays it out. Keeping it here means a new meta block is an edit to one
function in a small file rather than growth in the file that holds the
decisions.

``index`` and ``coverage`` are present on EVERY path, refusals included,
because a refusal that omits them cannot say why it refused. Both render
as "not measured" rather than as zeros when nothing was taken, which is
the same discipline ``StatusMap.complete`` carries: a reading that did
not happen is not a reading of nothing.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from src.core.archive_envelope import envelope
from src.core.archive_read import offset_units_meta
from src.core.archive_search_fts import ORDER_POSITION, BlockFilters
from src.core.archive_snippet_gate import snippet_gate_meta

SCOPE_PROJECT = "project"


def envelope_for(
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
