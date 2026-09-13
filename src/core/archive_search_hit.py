"""Render one FTS hit, with its preview cut from the BLOCK, not the body.

WHY THIS IS NOT ``archive_snippet_gate.build_hit``. That one cuts its
window out of ``message_bodies.body_json`` with SQL's ``SUBSTR``, using a
``match_offset`` measured in that same column. An FTS hit's offset is
measured in ``message_content_blocks.text``, so re-using that cutter
would slice the wrong string at the right number and hand back a window
of somebody else's JSON. Two different frames of reference is exactly
how a preview comes to be confidently wrong.

THE GATE IS THE SAME GATE, DELIBERATELY, AND THAT IS THE WHOLE SAFETY
ARGUMENT. A block's text is a SUBSTRING of the body text
``archive_snippet_gate`` already governs, so it inherits precisely the
same exposure and must inherit precisely the same policy. All three
layers run here, in the same order, through the same functions: layer 1
is the body's ``secret_finding_count``, layer 2 runs the detectors over
the candidate window, layer 3 tests it against every value this corpus
has ever had detected. There is no second policy and no new state name.

``match_offset`` NOW NAMES A POSITION IN THE BLOCK, and the hit says so
rather than leaving a reader to assume. ``match_offset_in`` carries the
frame of reference explicitly, and ``block_id``/``block_seq`` name the
string it indexes into. Checked before shipping: nothing under
``client/`` reads ``match_offset`` off a search hit (``archive-mask.js``
reads ``match_offset_utf16`` off SECRET FINDINGS, which is a different
endpoint and is untouched), so this changes no rendering.

WHAT IS ADDED, AND WHY NONE OF IT IS A SHAPE CHANGE. ``block_id``,
``block_seq``, ``block_type``, ``tool_name``, ``is_error``, ``role``,
``model``, ``rank_score``, ``match_offset_in`` and ``block_chars`` are
NEW KEYS. Every key the old hit carried is still here, with the same
name and the same meaning, ``match_offset`` excepted as described above.
An added key cannot break a caller that does not read it.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Dict, Optional, Tuple

from src.core.archive_cursor import CURSOR_LINES, CURSOR_VERSION, encode_cursor
from src.core.archive_read import RESULT_CANNOT_DETERMINE
from src.core.archive_snippet_gate import (
    BODIES_HREF,
    LINES_HREF,
    SNIPPET_CONTEXT_CHARS,
    SNIPPET_INCLUDED,
    SNIPPET_WITHHELD_BY_REQUEST,
    SNIPPET_WITHHELD_FLAGGED_BODY,
    KnownSecretIndex,
    evaluate_window,
    layer_one_state,
)


#: A SECOND query, issued ONLY for a block whose body cleared layer 1.
#: SUBSTR cuts inside SQLite, so a megabyte tool_result is never
#: transferred here - the same method and the same reason as
#: ``archive_snippet_gate._SNIPPET_SQL``. 51 of these measured 0.17 ms.
_BLOCK_WINDOW_SQL: str = """
SELECT SUBSTR(text, :start_1based, :length) AS window
  FROM message_content_blocks WHERE id = :block_id
"""


def block_snippet(
    conn: sqlite3.Connection,
    block_id: int,
    block_chars: Optional[int],
    match_offset: int,
    match_length: int,
    index: Optional[KnownSecretIndex],
) -> Tuple[Optional[str], str]:
    """Cut a context window out of a block's text, then GATE it.

    Description: the window is read in order to be cleared, and it is
      dropped unreturned and never logged when the gate refuses. Layer 1
      has already run in :func:`build_fts_hit`; this is layers 2 and 3.
    Inputs: conn (sqlite3.Connection). block_id (int). block_chars
      (int|None) - the block's own length, used only to decide whether an
      ellipsis is truthful. match_offset (int, 0-based, in that text).
      match_length (int). index (KnownSecretIndex|None) - None means the
      gate could not be built, which WITHHOLDS rather than permits.
    Output: (snippet or None, snippet_state). ``(None,
      "cannot_determine")`` when the row vanished between the two queries
      or carries no text at all - never an empty preview.
    Example: block_snippet(conn, 7, 40, 6, 5, idx)[1] -> 'included'
    """
    if block_chars is None:
        # The block row exists and its text is NULL: an image or a
        # document, whose payload is bytes and is deliberately not
        # projected. Nothing to preview and nothing withheld.
        return None, RESULT_CANNOT_DETERMINE
    start = max(0, match_offset - SNIPPET_CONTEXT_CHARS)
    end = match_offset + match_length + SNIPPET_CONTEXT_CHARS
    row = conn.execute(_BLOCK_WINDOW_SQL, {
        "start_1based": start + 1, "length": end - start,
        "block_id": block_id,
    }).fetchone()
    if row is None or row["window"] is None:
        return None, RESULT_CANNOT_DETERMINE
    withheld = evaluate_window(row["window"], index)
    if withheld is not None:
        return None, withheld
    prefix = "..." if start > 0 else ""
    suffix = "..." if end < block_chars else ""
    return f"{prefix}{row['window']}{suffix}", SNIPPET_INCLUDED


def build_fts_hit(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    q: str,
    index: Optional[KnownSecretIndex],
    snippets: bool,
) -> Dict[str, Any]:
    """Render one row from ``archive_search_fts.run_hit_query`` as a hit.

    Description: a SECRET-BEARING HIT IS STILL A HIT. When the body
      carries findings the PREVIEW is withheld and the hit is reported
      anyway, with its transcript, line, offset and length, because
      dropping it would make the corpus's most sensitive material the
      least findable.
    Inputs: conn (sqlite3.Connection) - for the preview window query.
      row (sqlite3.Row) - a hit query row. q (str) - the literal
      matched, whose length is the match length. index
      (KnownSecretIndex|None). snippets (bool) - False withholds every
      preview, which is the only HARD guarantee here.
    Output: dict - the hit.
    Example: build_fts_hit(conn, row, "tmux", idx, True)["block_type"]
    """
    secret_count = int(row["secret_finding_count"])
    body_id = int(row["body_id"])
    offset = int(row["match_offset"])
    raw_chars = row["block_chars"]
    block_chars = None if raw_chars is None else int(raw_chars)
    block_id = int(row["block_id"])
    if not snippets:
        snippet, state = None, SNIPPET_WITHHELD_BY_REQUEST
    elif layer_one_state(secret_count) is not None:
        snippet, state = None, SNIPPET_WITHHELD_FLAGGED_BODY
    else:
        snippet, state = block_snippet(
            conn, block_id, block_chars, offset, len(q), index)
    line_no = int(row["line_no"])
    transcript_id = int(row["transcript_id"])
    href_cursor = encode_cursor(
        CURSOR_LINES, {"v": CURSOR_VERSION, "line_no": line_no - 1})
    is_error = row["is_error"]
    rank = row["rank_score"]
    return {
        "transcript_id": transcript_id,
        "session_ref": row["session_ref"],
        "line_no": line_no,
        "body_id": body_id,
        "match_offset": offset,
        # The frame of reference, stated rather than assumed. The old
        # offset indexed body_json; this one indexes the block's text.
        "match_offset_in": "block_text",
        "match_length": len(q),
        # body_chars is the truthful name; body_bytes is the same number.
        # Both are the BODY's character count, unchanged in meaning, and
        # both come from cloude_body_chars so a compressed row answers
        # the same number an uncompressed one does.
        "body_chars": int(row["body_bytes"]),
        "body_bytes": int(row["body_bytes"]),
        "block_id": block_id,
        "block_seq": int(row["block_seq"]),
        "block_type": row["block_type"],
        "block_chars": block_chars,
        "tool_name": row["tool_name"],
        "is_error": None if is_error is None else bool(is_error),
        "role": row["role"],
        "model": row["model"],
        # BM25 is negative and more negative is more relevant. None
        # whenever relevance was not asked for, so a client cannot mistake
        # a default ordering for a scored one.
        "rank_score": None if rank is None else float(rank),
        "secret_finding_count": secret_count,
        "snippet": snippet,
        "snippet_state": state,
        "body_href": BODIES_HREF.format(body_id=body_id),
        "lines_href": LINES_HREF.format(
            transcript_id=transcript_id, cursor=href_cursor),
    }
