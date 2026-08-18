"""Record classification and row shaping for the conversation archive.

Split out of ``history_queries`` so that module holds SQL and this one holds
the decisions about WHAT a record is and HOW a row becomes JSON. Both are
consumed by ``src/api/history.py``.
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Optional

import structlog

logger = structlog.get_logger()

#: Record types that are Claude Code bookkeeping, not conversation. Hidden
#: unless a caller explicitly asks for machinery. The first six are the set
#: named in the working spec. ``permission-mode`` is NOT in the archive
#: package's ``constants.ALL_KNOWN_RECORD_TYPES`` but 14 rows of it exist in
#: the live archive (measured 2026-08-18); it is bookkeeping by inspection
#: and is named here rather than silently rendered as a message.
MACHINERY_RECORD_TYPES: frozenset[str] = frozenset(
    {
        "queue-operation",
        "mode",
        "last-prompt",
        "attachment",
        "ai-title",
        "pr-link",
        "permission-mode",
    }
)

#: ``progress`` is never a message under any flag. 958,311 rows in the live
#: archive (measured 2026-08-18), all of them incremental "a tool is still
#: running" ticks superseded by the final assistant/user record. They fold
#: into their parent tool call as a count.
PROGRESS_RECORD_TYPE = "progress"

#: ``sessions.session_kind`` values. NULL means the row predates the column
#: and its kind CANNOT BE DETERMINED; it is counted separately rather than
#: assumed to be a main session.
SESSION_KIND_MAIN = "main"
SESSION_KIND_SUBAGENT = "subagent"

#: Columns pulled for a thread window. ``raw_json`` is deliberately absent:
#: it is the largest column in the archive and the window renders without
#: it. Drill-down fetches it per message, and that is a later phase.
_MESSAGE_COLUMNS = (
    "id, uuid, seq_in_file, record_type, role, is_sidechain, agent_id, "
    "tool_use_id, timestamp, text_content, has_tool_use, has_tool_result, "
    "is_compact_boundary, compact_subtype, raw_stored, model, "
    "usage_input_tokens, usage_output_tokens, usage_cache_read_tokens, "
    "usage_cache_creation_tokens, tool_use_ids_json"
)

def _as_str(value: Any) -> Optional[str]:
    """Render a database value as a string, preserving None.

    Args:
        value: any column value.

    Returns:
        str | None: str(value), or None when the value was NULL. NULL is
        kept as null rather than becoming "None" or "", because "not
        recorded" and "empty" are different facts.
    """
    return None if value is None else str(value)


def _collapse(text: Optional[str], max_chars: int) -> str:
    """Collapse whitespace and clip a string for a one-line stub.

    Args:
        text: source text, possibly None or multi-line.
        max_chars: maximum characters to keep.

    Returns:
        str: single-line text, suffixed with an ellipsis when clipped.
    """
    if not text:
        return ""
    flat = " ".join(text.split())
    if len(flat) <= max_chars:
        return flat
    return flat[:max_chars].rstrip() + "..."


def _row_to_message(row: Any) -> dict:
    """Convert one ``messages`` row into the viewer's message shape.

    Token usage fields are per ASSISTANT TURN, not per tool call. They are
    returned under a ``turn_cost`` key so a future UI cannot casually label
    them per-call, which would be a lie on any turn carrying several tool
    uses.

    Args:
        row: a SQLAlchemy row from a ``_MESSAGE_COLUMNS`` select.

    Returns:
        dict: JSON-serializable message.
    """
    return {
        "id": row.id,
        "uuid": row.uuid,
        "seq_in_file": row.seq_in_file,
        "record_type": row.record_type,
        "role": row.role,
        "is_sidechain": bool(row.is_sidechain),
        "agent_id": row.agent_id,
        "timestamp": _as_str(row.timestamp),
        "text_content": row.text_content,
        "text_truncated": False,
        "has_tool_use": bool(row.has_tool_use),
        "has_tool_result": bool(row.has_tool_result),
        "is_compact_boundary": bool(row.is_compact_boundary),
        "compact_subtype": row.compact_subtype,
        "raw_stored": bool(row.raw_stored),
        "model": row.model,
        "tool_use_ids": _parse_tool_use_ids(row.tool_use_ids_json),
        "folded_progress_count": 0,
        "turn_cost": {
            "input_tokens": row.usage_input_tokens,
            "output_tokens": row.usage_output_tokens,
            "cache_read_tokens": row.usage_cache_read_tokens,
            "cache_creation_tokens": row.usage_cache_creation_tokens,
            "scope": "assistant_turn",
        },
    }


def _parse_tool_use_ids(raw: Optional[str]) -> list[str]:
    """Parse the ``tool_use_ids_json`` column into a list.

    Args:
        raw: the stored JSON array, or None.

    Returns:
        list[str]: tool_use ids on this turn. Empty when the column is NULL
        (the row predates the backfill or carries no tool call) or holds
        something that is not a JSON array of strings.
    """
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        logger.warning("history_bad_tool_use_ids_json")
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed]


def apply_text_cap(messages: Iterable[dict], max_chars: int) -> int:
    """Clip over-long message bodies in place and flag each one clipped.

    A single pasted log can be megabytes; sending it whole to a phone is
    the difference between a usable reader and a hung tab. Truncation is
    always FLAGGED so the reader knows there is more, rather than silently
    served a shortened body.

    Args:
        messages: message dicts from :func:`_row_to_message`.
        max_chars: cap per message body.

    Returns:
        int: how many messages were clipped.
    """
    clipped = 0
    for message in messages:
        body = message.get("text_content")
        if body is not None and len(body) > max_chars:
            message["text_content"] = body[:max_chars]
            message["text_truncated"] = True
            clipped += 1
    return clipped


def fold_progress(messages: list[dict], counts: dict[str, int]) -> int:
    """Attach folded ``progress`` tick counts to their parent turns.

    Args:
        messages: the window's messages, in seq order.
        counts: tool_use_id to tick count, from ``progress_counts``.

    Returns:
        int: total ticks that could NOT be attributed to a message in this
        window. Reported rather than discarded: a nonzero value means ticks
        belong to a tool call whose parent turn is outside the window, and
        the caller says so instead of implying there were none.
    """
    attributed = 0
    for message in messages:
        total = sum(counts.get(tool_id, 0) for tool_id in message["tool_use_ids"])
        message["folded_progress_count"] = total
        attributed += total
    return sum(counts.values()) - attributed