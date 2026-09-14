"""Send archive-side DDL to the archive database, not to main.

WHY THIS EXISTS, MEASURED ON LIVE 2026-09-14. The split moved the whole
``message_*`` family into ``cloude-archive.db`` and dropped it from
``cloude.db``. The server then started, and 23 of those objects were
RECREATED IN MAIN, so every one of them existed in both files. sqlite
resolves an unqualified name to main, so every archive query would have
been reading the empty copy in main while the real one sat in the archive
file. ``assert_no_shadowing`` caught it, which is the entire argument for
that guard.

The culprit is not a bug, it is a deliberate self-heal:
``src/main.py`` calls ``db_steps.apply_message_model_schema`` on EVERY
enabled start, because an install that crossed v16/v17/v18 with the
archive flag off has no ``message_*`` tables and no remaining migration
step that would create them. It is idempotent and additive and it should
keep running. It simply has to create the tables in the right FILE.

THE FIX IS AT THE DDL, NOT AFTER IT. Dropping the tables again after boot
was considered and rejected: a table that is created and then removed is
a race waiting for a slow boot, and anything that read in between would
read the wrong file. Qualifying the CREATE is the only version with no
window.

AN UNPARSEABLE STATEMENT REFUSES. :func:`qualify_ddl` returns None rather
than guessing, and its caller raises. This project has already paid for
the other choice once: a rewrite that fell back to replacing the first
bare occurrence of a name produced ``CREATE TABLE 'archive.message_...'``
and sqlite accepted it, unqualified, into main, as four junk tables with
literal dots in their names.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Optional

from src.core.archive_db_partition import ARCHIVE_SCHEMA

#: Matches the head of every CREATE this schema uses, capturing the
#: leading keywords and the object name separately so only the name is
#: rewritten. Deliberately anchored at the start: a CREATE appearing
#: inside a view body or a trigger is not this statement's own object.
_CREATE_HEAD = re.compile(
    r"""^\s*CREATE\s+
        (?P<kind>(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(?:TABLE|INDEX|VIEW|TRIGGER))\s+
        (?P<exists>IF\s+NOT\s+EXISTS\s+)?
        (?P<name>
            (?:"[^"]+"|'[^']+'|\[[^\]]+\]|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)
            # An ALREADY QUALIFIED name must be captured WHOLE, dot and
            # all, so the "." test below can reject it. Matching only the
            # first part left `CREATE TABLE archive.t` looking bare and
            # rewrote it to `archive."archive".t`. Caught by this
            # module's own negative control.
            (?:\s*\.\s*
               (?:"[^"]+"|'[^']+'|\[[^\]]+\]|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)
            )?
        )
    """,
    re.IGNORECASE | re.VERBOSE,
)


#: ALTER TABLE resolves to the attached schema by the same rule as
#: SELECT, so it needs no rewrite. Recognised explicitly so that
#: "not a CREATE" still refuses.
_ALTER_HEAD = re.compile(r"^\s*ALTER\s+TABLE\s+", re.IGNORECASE)


def _bare(name: str) -> str:
    """Strip one layer of sqlite identifier quoting.

    Description: private. sqlite stores a name bare, "double quoted",
      'single quoted', [bracketed] or `backticked` depending on how it
      was written, and all five mean the same identifier.
    Inputs: name (str) - the captured name token.
    Output: str - the identifier with quoting removed.
    Example: _bare("'message_bodies'")  # 'message_bodies'
    """
    if len(name) >= 2 and name[0] in "\"'[`":
        return name[1:-1]
    return name


def archive_schema_if_attached(conn: sqlite3.Connection) -> Optional[str]:
    """Return the archive schema name when this connection has one.

    Description: the single condition that decides where archive DDL
      lands. Reads ``PRAGMA database_list``, which is the only authority
      on what a connection can actually see, rather than a flag that can
      disagree with the connection in hand.

      A FRESH INSTALL HAS NO ARCHIVE FILE and answers None, so its DDL
      goes to main exactly as it always did and the migration moves it
      later. A SPLIT INSTALL answers ``archive`` and its DDL goes
      straight to the right file. Both are correct and neither needs a
      setting.
    Inputs: conn (sqlite3.Connection).
    Output: str | None - ARCHIVE_SCHEMA, or None when nothing is attached.
    Example: archive_schema_if_attached(conn)  # 'archive' on a split install
    """
    try:
        names = {row[1] for row in conn.execute("PRAGMA database_list")}
    except sqlite3.Error:
        return None
    return ARCHIVE_SCHEMA if ARCHIVE_SCHEMA in names else None


def qualify_ddl(statement: str, schema: Optional[str]) -> Optional[str]:
    """Point one CREATE statement at a schema, or refuse to touch it.

    Description: rewrites ONLY the object's own name, leaving the body
      alone. An index's ``ON <table>`` and a view's ``FROM <table>`` are
      deliberately NOT qualified: they resolve inside the schema the
      object is created in, which is exactly what is wanted, and
      rewriting them would break a view that legitimately reads across
      the boundary.

      ``schema`` of None means "leave it alone", which is the fresh
      install case and must stay a no-op rather than an error.
    Inputs: statement (str) - one CREATE statement. schema (str | None).
    Output: str | None - the rewritten statement, the original when
      schema is None, or None when the statement could not be parsed and
      the caller must refuse.
    Example: qualify_ddl("CREATE TABLE IF NOT EXISTS t(a)", "archive")
      # 'CREATE TABLE IF NOT EXISTS archive."t"(a)'
    """
    if schema is None:
        return statement
    if _ALTER_HEAD.match(statement):
        # ALTER TABLE is passed through DELIBERATELY, not by falling
        # through. MEASURED on sqlite 3.53.4: with the table present only
        # in the attached database, `ALTER TABLE t ADD COLUMN c` lands in
        # the ATTACHED one, by the same name-resolution rule that governs
        # SELECT and INSERT, and `PRAGMA table_info(t)` reads it from
        # there too. So the v17 step's six guarded ALTERs and the
        # table_info read they are guarded against both follow the
        # CREATEs to whichever file those went to, with no rewrite. This
        # is an allow, not a default: anything not recognised still
        # refuses below.
        return statement
    match = _CREATE_HEAD.match(statement)
    if match is None:
        return None
    name = _bare(match.group("name"))
    if "." in name:
        # Already qualified, or a name this code must not invent a
        # meaning for. Either way it is not ours to rewrite.
        return None
    start, end = match.span("name")
    return f'{statement[:start]}{schema}."{name}"{statement[end:]}'


def execute_archive_ddl(conn: sqlite3.Connection, statements) -> int:
    """Run archive-side DDL against the archive database when there is one.

    Description: the ONE seam every archive DDL path goes through, so a
      new table added to any of the ``DDL_V*`` tuples lands in the right
      file without its author having to know this exists. On an unsplit
      install it is exactly the loop it replaces.
    Inputs: conn (sqlite3.Connection), statements (Iterable[str]).
    Output: int - how many statements were qualified onto the archive.
    Raises: sqlite3.OperationalError - a statement could not be parsed,
      so it was not executed. Refusing beats creating it in main, which
      is the failure this module exists to prevent.
    Example: execute_archive_ddl(conn, DDL_V16)
    """
    schema = archive_schema_if_attached(conn)
    qualified = 0
    for statement in statements:
        targeted = qualify_ddl(statement, schema)
        if targeted is None:
            raise sqlite3.OperationalError(
                "refusing to execute archive DDL that could not be pointed at "
                f"the {schema!r} schema: {statement.strip()[:120]!r}. "
                "Executing it unqualified would create it in cloude.db, where "
                "it would shadow the archive copy and silently win every read"
            )
        conn.execute(targeted)
        if schema is not None:
            qualified += 1
    return qualified
