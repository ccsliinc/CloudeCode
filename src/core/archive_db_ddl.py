"""Rewrite archive DDL so it can live in a separate database file.

WHY THIS MODULE EXISTS, AND IT IS NOT THE REASON THE SCOPE DOC GIVES.
``docs/history-archive-scope.md`` records that a cross-database foreign
key "cannot be expressed at all" and takes comfort from the refusal being
hard rather than silent. MEASURED on sqlite 3.53.4, 2026-09-13, both
files in WAL with ``PRAGMA foreign_keys=ON``, that is only half right and
the other half is dangerous:

  CREATE TABLE arch.t(sid INTEGER REFERENCES main.sessions(id))
    -> OperationalError: near ".": syntax error        (DDL time, as documented)

  CREATE TABLE arch.t2(sid INTEGER REFERENCES sessions(id))
    -> ACCEPTED                                        (NOT as documented)

The unqualified form is accepted at DDL time and fails only at DML time,
with ``no such table: arch.sessions`` on EVERY insert, because an
unqualified REFERENCES resolves inside the table's OWN database. That was
proven rather than inferred: after creating an ``arch.sessions``, a row
referencing a value present only there was accepted, and a row
referencing a value present only in ``main.sessions`` was refused with
FOREIGN KEY constraint failed.

AND ``PRAGMA arch.foreign_key_check`` RETURNS EMPTY ON SUCH A TABLE. It
does not report the dangling target. So a migration that copied the DDL
verbatim would create all three tables successfully, pass every integrity
check, report success, and leave an archive nothing can ever write to.
That is the exact failure this project's rules exist to prevent, and it
is why :func:`strip_crossing_references` is mandatory rather than tidy,
and why the caller must PROVE the strip worked with a real write rather
than by reading the DDL back.

WHAT IS STRIPPED AND WHAT IS KEPT. Only references to APP-side tables go.
The archive's internal keys are untouched and still enforced, including
the one ``ON DELETE CASCADE`` on ``transcript_records.archive_id``, which
is entirely archive-internal and survives the split unchanged.
"""

from __future__ import annotations

import re
from typing import List, Sequence, Tuple

from src.core.archive_db_partition import APP_TABLES

#: Matches a REFERENCES clause pointing at one named parent table, with
#: the optional trailing referential actions sqlite allows after it. The
#: parent name is injected escaped, so this is never a user-supplied
#: pattern. ``DEFERRABLE`` is included because sqlite accepts it and a
#: leftover fragment would be a syntax error rather than a silent bug.
_ACTIONS = (
    r"(?:\s+ON\s+(?:DELETE|UPDATE)\s+"
    r"(?:CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))*"
    r"(?:\s+(?:NOT\s+)?DEFERRABLE(?:\s+INITIALLY\s+(?:DEFERRED|IMMEDIATE))?)?"
)


def _reference_pattern(parent: str) -> re.Pattern:
    """Build the regex that matches a REFERENCES clause to one parent.

    Description: private helper so the pattern is written once. Accepts
      the bare and the double-quoted spelling of the table name and an
      optional parenthesised column list, which is how this schema
      spells all three crossing keys.
    Inputs: parent (str) - an app-side table name.
    Output: re.Pattern, case-insensitive and DOTALL-safe.
    Example: _reference_pattern("sessions").search("REFERENCES sessions(id)")
    """
    return re.compile(
        r"\s*REFERENCES\s+[\"\[`]?" + re.escape(parent) + r"[\"\]`]?"
        r"\s*(?:\([^)]*\))?" + _ACTIONS,
        re.IGNORECASE,
    )


def strip_crossing_references(sql: str) -> Tuple[str, List[str]]:
    """Remove every REFERENCES clause pointing at an app-side table.

    Description: the ONLY transformation applied to archive DDL on its
      way into the separate file. Archive-internal foreign keys are left
      exactly as they are and stay enforced. The columns themselves are
      untouched: ``root_session_id`` and ``project_id`` remain plain
      INTEGER columns carrying the same values, and their integrity
      becomes application-level.
    Inputs: sql (str) - one CREATE TABLE statement from sqlite_master.
    Output: tuple[str, list[str]] - the rewritten DDL, and the names of
      the parent tables whose references were removed (one entry per
      clause removed, so a caller can count them).
    Example: strip_crossing_references(
        'CREATE TABLE t(a INTEGER REFERENCES sessions(id))')
      # ('CREATE TABLE t(a INTEGER)', ['sessions'])
    """
    removed: List[str] = []
    out = sql
    for parent in sorted(APP_TABLES):
        pattern = _reference_pattern(parent)
        while True:
            match = pattern.search(out)
            if match is None:
                break
            out = out[: match.start()] + out[match.end():]
            removed.append(parent)
    return out, removed


def residual_app_references(sql: str) -> List[str]:
    """Name any app-side REFERENCES still present in a DDL string.

    Description: a STATIC check, and it is deliberately not the only
      one. It proves the string no longer mentions an app table; it does
      NOT prove the resulting table is writable, because the failure
      this guards against is a DML-time resolution error that no amount
      of reading the schema can reveal. The caller pairs this with a
      real write probe. Belt first, then braces.
    Inputs: sql (str) - a CREATE TABLE statement.
    Output: list[str] - parent table names still referenced, sorted.
    Example: residual_app_references("CREATE TABLE t(a INTEGER)")  # []
    """
    found = [p for p in sorted(APP_TABLES) if _reference_pattern(p).search(sql)]
    return found


def rewrite_for_archive(statements: Sequence[Tuple[str, str]]) -> List[Tuple[str, str, List[str]]]:
    """Rewrite a batch of archive DDL statements for the separate file.

    Description: convenience over :func:`strip_crossing_references` that
      keeps each statement paired with the object it creates, so the
      migration can report per-table what it changed rather than a bare
      total.
    Inputs: statements (Sequence[tuple[str, str]]) - (object_name, sql).
    Output: list[tuple[str, str, list[str]]] - (name, rewritten_sql,
      removed_parents).
    Example: rewrite_for_archive([("t", "CREATE TABLE t(a INTEGER)")])
      # [('t', 'CREATE TABLE t(a INTEGER)', [])]
    """
    out: List[Tuple[str, str, List[str]]] = []
    for name, sql in statements:
        rewritten, removed = strip_crossing_references(sql)
        out.append((name, rewritten, removed))
    return out


def restore_crossing_references(sql: str, columns: Sequence[Tuple[str, str]]) -> str:
    """Re-impose app-side foreign keys on DDL heading back into main.

    Description: the REVERSE migration's half of the transformation. It
      appends table-level FOREIGN KEY clauses rather than trying to
      re-inject column constraints into a string it did not write, which
      is both simpler and produces DDL a human can read. Re-imposing the
      constraint is the integrity check the split gave up, run once: if
      any reference has been orphaned while the databases were apart,
      the copy back fails LOUDLY at insert time instead of silently
      restoring a broken relationship.
    Inputs: sql (str) - the stripped CREATE TABLE statement. columns
      (Sequence[tuple[str, str]]) - (column_name, parent_table) pairs to
      re-constrain.
    Output: str - DDL with the FOREIGN KEY clauses appended.
    Example: restore_crossing_references(
        "CREATE TABLE t(a INTEGER)", [("a", "sessions")])
      # 'CREATE TABLE t(a INTEGER, FOREIGN KEY(a) REFERENCES sessions(id))'
    """
    if not columns:
        return sql
    closing = sql.rstrip().rstrip(")")
    clauses = ", ".join(
        f'FOREIGN KEY("{col}") REFERENCES "{parent}"(id)' for col, parent in columns
    )
    return f"{closing}, {clauses})"
