"""DDL for schema v27: the FTS5 index over ``message_content_blocks.text``.

WHAT THIS REPLACES, AND WHY IT IS A CORRECTNESS FIX RATHER THAN A SPEED
ONE. ``archive_search`` matched with ``INSTR(body_json, needle)``, and
``body_json`` is the WHOLE jsonl record: ``cwd``, ``sessionId``,
``parentUuid``, ``timestamp``, ``gitBranch``, ``entrypoint``,
``version``, ``promptId`` and the message together. So a search for a
model name matched the envelope of every message that model produced.

MEASURED on the 400-transcript projection, 2026-09-13, both halves taken
in the same pass so they are comparable:

  needle                       bodies by INSTR   blocks by INSTR
  claude-opus-4                         33,805               165
  "cache_read_input_tokens"             91,623                30
  msg_01                                89,837                27
  "tool_use_id"                         38,887                28

The right-hand column is the answer a human wanted. A miss cost 919 ms
over 755.9 MiB at 863 MB/s; the same miss against this index is 0.01 ms.

TOKENIZER: ``unicode61 remove_diacritics 2``, and the alternative was
MEASURED rather than reasoned about. Built over the same 112,623 blocks
holding 125.1 MiB of text:

  unicode61   51.4 MiB, 1.80 s to build, queries 0.03 to 0.51 ms
  trigram    332.3 MiB, 13.12 s to build, queries 0.72 to 4.13 ms

Trigram is strictly more capable - it is substring matching, which is
what ``INSTR`` gave - and on the one query where that shows, ``resize``,
it found 854 blocks against unicode61's 752, because ``sendResize``
contains ``resize`` and unicode61 makes that identifier ONE token. That
is a real 13.6 percent of that query's answers.

It is still not worth 281 MiB here, and the reason is specific rather
than aesthetic: the other half of this change compresses ``body_json``
and saves 358.7 MiB. Paying 281 MiB for trigram would hand back 78
percent of that saving to buy substring matching on identifiers. So
unicode61 ships and THE GAP IS NAMED: a camelCase identifier is one
token, so a search for part of one does not find it. A path SEGMENT is
findable (``session_manager`` returned 2,220 blocks); a whole path is
findable only as a phrase.

Note what unicode61 gets RIGHT that trigram does not: ``"tmux -L
cloude"`` as a phrase returned 798 blocks against trigram's 771, because
unicode61 matches the three tokens in order regardless of the punctuation
and spacing between them, while trigram can only find the exact byte
string. Neither is uniformly better.

CONTENTLESS, WITH ``contentless_delete=1``. ``content=''`` stores no copy
of the text - the row is fetched by rowid, which IS
``message_content_blocks.id``, so the join back is an INTEGER PRIMARY KEY
seek. That is the only reason 125.1 MiB of text costs 51.4 MiB of index
rather than 176. ``contentless_delete=1`` (SQLite 3.43+, this box runs
3.53.4) is what makes a plain ``DELETE FROM ... WHERE rowid = ?`` legal
on a contentless table, and therefore what makes the delete trigger a
one-liner instead of a command that has to re-supply the original text.

TRIGGERS, NOT AN EXPLICIT WRITE PATH, AND THE REASON IS THE CASCADE.
``message_content_blocks.body_id`` is ``REFERENCES message_bodies(id) ON
DELETE CASCADE``, and the projection DOES delete bodies - a transcript
that grew is replaced. A cascade is invisible to Python: the rows vanish
and nothing calls an updater. A trigger sees it, inside the same
transaction. Verified against a real SQLite: after a cascading delete of
the parent body, the FTS row for its block was gone.

What a trigger CANNOT protect against is being absent - an install
migrated by an older build, or a table created before the trigger
existed. So the status ladder in
``src/core/message_block_search_status.py`` compares the FTS row count
against the block count and reports ``stale`` rather than assuming
agreement. A trigger cannot drift while it exists; it can be missing.
"""

from __future__ import annotations

from typing import Tuple

#: The FTS5 table's name. Spelled from here by every query and every
#: trigger, so a rename is one edit and a typo is a loud "no such table".
BLOCK_SEARCH_TABLE: str = "message_block_search"

#: The tokenizer argument, verbatim. ``remove_diacritics 2`` is the
#: Unicode-correct form (1 is the legacy one that only handles Latin-1),
#: and it is stated rather than defaulted so an SQLite whose default
#: moves cannot silently change what this index means.
BLOCK_SEARCH_TOKENIZER: str = "unicode61 remove_diacritics 2"

#: Trigger names, in creation order.
BLOCK_SEARCH_TRIGGERS: Tuple[str, ...] = (
    "message_block_search_ai",
    "message_block_search_ad",
    "message_block_search_au",
)

DDL_MESSAGE_BLOCK_SEARCH = f"""
CREATE VIRTUAL TABLE IF NOT EXISTS {BLOCK_SEARCH_TABLE} USING fts5(
  text,
  content='',
  contentless_delete=1,
  tokenize="{BLOCK_SEARCH_TOKENIZER}"
)
"""

#: A block whose text is NULL or empty is NOT indexed. 24,545 of the
#: corpus's 137,168 blocks are in that state - images and documents,
#: whose payload ``message_block_extract.project_block`` deliberately
#: does not project because it is bytes rather than text. Indexing an
#: empty string would put a row in the index that can never match and
#: would make the row-count check below disagree with itself forever.
DDL_TRIGGER_BLOCK_SEARCH_INSERT = f"""
CREATE TRIGGER IF NOT EXISTS message_block_search_ai
AFTER INSERT ON message_content_blocks
WHEN new.text IS NOT NULL AND new.text <> ''
BEGIN
  INSERT INTO {BLOCK_SEARCH_TABLE}(rowid, text) VALUES (new.id, new.text);
END
"""

#: Unconditional, deliberately. The INSERT trigger is conditional, so a
#: row may or may not have an index entry, and a conditional DELETE would
#: have to re-derive which - getting that wrong leaves an orphan entry
#: that matches a block nobody can fetch. Deleting a rowid that is not
#: there is a no-op on a contentless_delete table.
DDL_TRIGGER_BLOCK_SEARCH_DELETE = f"""
CREATE TRIGGER IF NOT EXISTS message_block_search_ad
AFTER DELETE ON message_content_blocks
BEGIN
  DELETE FROM {BLOCK_SEARCH_TABLE} WHERE rowid = old.id;
END
"""

#: Delete then re-insert, because the text may have become empty or
#: stopped being empty and either direction has to be honoured.
DDL_TRIGGER_BLOCK_SEARCH_UPDATE = f"""
CREATE TRIGGER IF NOT EXISTS message_block_search_au
AFTER UPDATE ON message_content_blocks
BEGIN
  DELETE FROM {BLOCK_SEARCH_TABLE} WHERE rowid = old.id;
  INSERT INTO {BLOCK_SEARCH_TABLE}(rowid, text)
    SELECT new.id, new.text WHERE new.text IS NOT NULL AND new.text <> '';
END
"""

#: Ordered DDL for a v26 -> v27 database. Every statement carries its own
#: IF NOT EXISTS, so the step is safe on a retry - the same idiom
#: v7/v8/v14/v16/v18 already use for the same reason. NOTHING HERE
#: POPULATES the index: a CREATE that also ran the 1.80 s build would put
#: an unbounded write inside the migration transaction, and on a corpus
#: 20 times this size that is a boot that looks hung. The build is its
#: own named operation with its own liveness record.
DDL_V27: Tuple[str, ...] = (
    DDL_MESSAGE_BLOCK_SEARCH,
    DDL_TRIGGER_BLOCK_SEARCH_INSERT,
    DDL_TRIGGER_BLOCK_SEARCH_DELETE,
    DDL_TRIGGER_BLOCK_SEARCH_UPDATE,
)

#: Object names v27 creates, in creation order. Used by the migration
#: test so it does not re-list them (a second list that can drift).
V27_OBJECT_NAMES: Tuple[str, ...] = (
    BLOCK_SEARCH_TABLE,
) + BLOCK_SEARCH_TRIGGERS
