"""How a search explains itself when it finds nothing, or cannot look.

WHY THIS IS ITS OWN MODULE. ``archive_search.py`` was already at the
repo's 500-line guideline before the matcher moved, and the wording of a
refusal is the part of it that will keep growing: every rung that can
answer "I could not evaluate this" needs a sentence a human can act on.
Those sentences live here, with the measurements that justify them, so
the search module keeps the LADDER and this one keeps the PROSE.

EVERY FUNCTION HERE PRODUCES A SENTENCE A USER CAN ACT ON. "Some content
is not searchable" is not actionable; "79,667 bodies in scope carry no
message text" is. That is the whole standard this module is held to.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Dict, Optional

from src.core.message_block_search_state import read_liveness
from src.core.message_block_search_status import COVERAGE_INDEXED, Coverage


class SearchInputError(ValueError):
    """A caller-supplied argument could not be evaluated.

    Description: carries the ``subject``/``reason`` pair that goes
      straight into the envelope's ``unevaluated`` list, so a refusal is
      never reduced to a bare exception type.
    Inputs: subject (str) - the field at fault. reason (str).
    Output: an exception instance carrying ``.subject`` and ``.reason``.
    Example: SearchInputError("q", "q is required").subject -> 'q'
    """

    def __init__(self, subject: str, reason: str) -> None:
        super().__init__(f"{subject}: {reason}")
        self.subject = subject
        self.reason = reason


def coverage_reason(coverage: Coverage) -> str:
    """Word the refusal an empty result over unindexed bodies earns.

    Description: names the COUNT and the REASONS. Measured on the
      400-transcript projection: 79,667 of 216,716 bodies (36.8 percent)
      carry no message text at all - attachments, file-history snapshots
      and titles - so they cannot match, and an empty list would report
      that identically to "searched everything, found nothing".
    Inputs: coverage (Coverage) - must be ``complete``.
    Output: str.
    Example: coverage_reason(cov) -> '3 of 10 bodies in scope are not ...'
    """
    parts = ", ".join(
        f"{count} {reason}"
        for reason, count in sorted(coverage.by_reason.items())
        if reason != COVERAGE_INDEXED)
    total = coverage.bodies_indexed + coverage.bodies_not_indexed
    return (
        f"{coverage.bodies_not_indexed} of {total} bodies in scope are not in "
        f"the search index and could not have matched ({parts}). "
        f"An empty result here means NOT FOUND IN INDEXED TEXT, which is "
        f"not the same as not present in this scope."
    )


def tokenizer_limit_reason(q: str) -> str:
    """Word the matcher's own gap, for an empty page.

    Description: ``unicode61`` matches whole tokens and prefixes of
      tokens, so a query beginning INSIDE a word cannot be found by it.
      Measured recall against a full substring scan of the same block
      text is 96.7 to 100 percent over twelve real queries, and the
      residue is exactly this case. A user who typed a word fragment and
      got nothing is entitled to know that before concluding the corpus
      does not hold it.
    Inputs: q (str) - the caller's query, quoted back to them.
    Output: str.
    Example: tokenizer_limit_reason("resize")
    """
    return (
        f"the index matches whole tokens and prefixes of tokens, so a query "
        f"beginning INSIDE a word cannot be found by it: 'resize' does not "
        f"reach 'sendResize'. Measured recall against a full substring scan "
        f"of the same text is 96.7 to 100 percent over twelve real queries. "
        f"If {q!r} begins mid-word, an empty result here is a limit of the "
        f"index rather than an absence in the corpus."
    )


def untokenizable_reason(q: str, tokenizer: str) -> str:
    """Word the refusal a query with no indexable term earns.

    Description: a string of punctuation produces no token, so the index
      cannot be asked about it at all. The substring scan this replaced
      COULD find such a string, so this is a real loss of capability and
      says so rather than answering zero hits.
    Inputs: q (str), tokenizer (str) - the configured tokenizer, named so
      the reader can see what rule produced no term.
    Output: str.
    Example: untokenizable_reason("...", "unicode61")
    """
    return (
        f"q holds no alphanumeric character, so the tokenizer ({tokenizer}) "
        f"produces no term from it and the index cannot be asked. The "
        f"substring scan this replaced COULD find such a string; that "
        f"capability is gone and this is the refusal saying so, rather than "
        f"a result of zero."
    )


def read_liveness_for(conn: sqlite3.Connection) -> Optional[Dict[str, Any]]:
    """Read the index build record for the database this connection holds.

    Description: the artifact lives beside the database file, so its
      directory is derived from the CONNECTION rather than from settings.
      A test pointing at a throwaway datastore then reads that
      datastore's own record instead of the developer's.
    Inputs: conn (sqlite3.Connection).
    Output: dict or None - None means NO RECORD, which is a different
      fact from a record saying a build failed.
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
