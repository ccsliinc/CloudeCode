"""Every named outcome the transcript restore path can produce.

WHY THESE LIVE IN ONE FILE. The restore path answers four questions in
sequence - which archive row, what bytes, which destination, did the
write land - and each one has its own three-outcome rule. Spreading the
names across the four modules that produce them makes it impossible to
read the whole refusal vocabulary at once, and a refusal vocabulary you
cannot read at once is one you cannot check for gaps.

THE RULE EVERY NAME HERE OBEYS: a MEASURED absence may act, an UNMEASURED
one may not. So "this uuid has no rows in the archive" (the query ran and
returned nothing) is a different constant from "the archive could not be
read" (no query ran). The first is a fact a human can act on. The second
is silence, and silence is never evidence.

NOTHING HERE IMPORTS ANYTHING FROM THIS PROJECT. It is constants and
tuples, so every other restore module can import it without a cycle.
"""

from __future__ import annotations

from typing import Tuple

# ---------------------------------------------------------------------
# 1. Resolving a conversation uuid to one archive row
# ---------------------------------------------------------------------

#: Exactly one latest row was found for this uuid.
RESOLVED: str = "resolved"

#: The query RAN and matched nothing. A measured absence: this uuid is
#: genuinely not in the archive, which is a fact worth telling a human.
NO_ARCHIVE_ROW: str = "no_archive_row"

#: No query ran, or it raised. NOT the same as "nothing matched", and
#: collapsing the two would report an unreadable database as an empty one.
DATABASE_UNREADABLE: str = "database_unreadable"

#: The stem matches rows under MORE THAN ONE project directory. Two
#: spellings of one cwd produce two transcript directories (gotcha 6), so
#: this is a real shape and not a defensive branch. Writing either one is
#: a guess, so it refuses and names both.
AMBIGUOUS_UUID: str = "ambiguous_uuid"

ALL_RESOLVE_OUTCOMES: Tuple[str, ...] = (
    RESOLVED,
    NO_ARCHIVE_ROW,
    DATABASE_UNREADABLE,
    AMBIGUOUS_UUID,
)

# ---------------------------------------------------------------------
# 2. Reconstructing that row's bytes
# ---------------------------------------------------------------------

#: Bytes were produced AND both sha256 and byte length match the row.
RECONSTRUCTED: str = "reconstructed"

#: A ``superseded_by_archive_id`` pointer dangled or formed a cycle.
CHAIN_BROKEN: str = "chain_broken"

#: zlib refused the terminal blob.
CONTENT_CORRUPT: str = "content_corrupt"

#: Bytes came out, and they are NOT what was ingested. The load-bearing
#: one: every other failure produces nothing, this one produces something
#: plausible. It must never reach the writer.
SELF_INCONSISTENT: str = "self_inconsistent"

ALL_RECONSTRUCT_OUTCOMES: Tuple[str, ...] = (
    RECONSTRUCTED,
    CHAIN_BROKEN,
    CONTENT_CORRUPT,
    SELF_INCONSISTENT,
)

# ---------------------------------------------------------------------
# 3. Deciding where the bytes belong
# ---------------------------------------------------------------------

#: A destination was resolved, sits under the corpus root, and nothing is
#: in the way.
TARGET_READY: str = "target_ready"

#: ``source_path`` resolved to somewhere outside the corpus root.
#: ``source_path`` is a database value, and a database value is data: a
#: ``..`` in it must not be able to steer a write out of the tree.
ESCAPES_CORPUS_ROOT: str = "escapes_corpus_root"

#: A file is already there. THE DEFAULT REFUSAL, and the most important
#: one in this module: claude may be appending to that file right now.
TARGET_EXISTS: str = "target_exists"

#: ``--overwrite`` was given AND the file on disk extends past the
#: reconstruction. Permission to replace a file is not permission to
#: shorten a conversation, so this refuses even under the opt-in.
SOURCE_IS_LONGER_THAN_ARCHIVE: str = "source_is_longer_than_archive"

#: The project directory does not exist. Not fatal on its own - a
#: conversation whose project directory was cleaned away is exactly the
#: case this feature exists for - so it is a refusal only without
#: ``--create-dirs``.
PARENT_MISSING: str = "parent_missing"

ALL_TARGET_OUTCOMES: Tuple[str, ...] = (
    TARGET_READY,
    ESCAPES_CORPUS_ROOT,
    TARGET_EXISTS,
    SOURCE_IS_LONGER_THAN_ARCHIVE,
    PARENT_MISSING,
)

# ---------------------------------------------------------------------
# 4. The write itself
# ---------------------------------------------------------------------

#: The bytes are on disk under the target name, and were read back and
#: re-hashed to prove it.
WRITTEN: str = "written"

#: The write was attempted and the filesystem refused it.
WRITE_FAILED: str = "write_failed"

#: :mod:`src.core.test_write_guard` refused the destination. Only
#: reachable during a test run, which is the point: a test that reaches
#: this writer with a real ``~/.claude`` path is stopped here.
REFUSED_BY_TEST_GUARD: str = "refused_by_test_guard"

#: The bytes landed but reading them back did not reproduce the hash.
#: Separate from WRITE_FAILED because the file EXISTS and is wrong, which
#: needs a different sentence to a human than "nothing was written".
VERIFY_AFTER_WRITE_FAILED: str = "verify_after_write_failed"

#: Nothing was attempted: this is a dry run. Carried as an outcome rather
#: than as an absence so a report never has a blank column.
DRY_RUN: str = "dry_run"

ALL_WRITE_OUTCOMES: Tuple[str, ...] = (
    WRITTEN,
    WRITE_FAILED,
    REFUSED_BY_TEST_GUARD,
    VERIFY_AFTER_WRITE_FAILED,
    DRY_RUN,
)

#: Every outcome this path can emit, for the test that asserts no module
#: has grown a name the vocabulary does not carry.
ALL_RESTORE_OUTCOMES: Tuple[str, ...] = (
    ALL_RESOLVE_OUTCOMES
    + ALL_RECONSTRUCT_OUTCOMES
    + ALL_TARGET_OUTCOMES
    + ALL_WRITE_OUTCOMES
)
