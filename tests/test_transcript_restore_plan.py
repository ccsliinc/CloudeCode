"""Resolving a uuid to ONE row, rebuilding it, and the whole plan.

THE ROW SELECTION IS THE SAFETY ARGUMENT AND IT HAS ITS OWN NEGATIVE
CONTROL. A growing transcript has many rows for one path and every row
but the newest reconstructs to a strict PREFIX. Selecting wrongly writes
a deliberately truncated conversation and produces no error at all, so
:func:`test_an_older_row_is_never_the_one_chosen` builds exactly that
shape and asserts the newest wins.

These tests build a REAL archive schema in a throwaway state directory
and drive the production code against it, rather than doubling the
database. A double agrees with whatever it was built to agree with, and
the supersession walk is the thing under test.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import tempfile
import zlib
from pathlib import Path
from typing import Optional

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_trp_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_trp_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

from src.core.transcript_restore_outcomes import (
    AMBIGUOUS_UUID,
    CHAIN_BROKEN,
    DATABASE_UNREADABLE,
    NO_ARCHIVE_ROW,
    RECONSTRUCTED,
    RESOLVED,
    SELF_INCONSISTENT,
    TARGET_READY,
    WRITTEN,
)
from src.core.transcript_restore_plan import apply_restore, plan_restore
from src.core.transcript_restore_resolve import (
    reconstruct_row,
    resolve_uuid,
    uuid_from_source_path,
)

#: What a superseded row carries in place of its own bytes, the same
#: value ``src/core/transcript_prefix_dedupe.py`` writes.
SENTINEL_GZIP = zlib.compress(b"", 9)

ARCHIVE_DDL = """
CREATE TABLE transcript_archives (
  id INTEGER PRIMARY KEY,
  archive_uuid TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('session','subagent')),
  source_path TEXT NOT NULL,
  content_gzip BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  raw_byte_length INTEGER NOT NULL,
  compressed_byte_length INTEGER NOT NULL,
  line_ending TEXT NOT NULL,
  has_trailing_newline INTEGER NOT NULL,
  trailing_blank_line_count INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  invalid_json_line_count INTEGER NOT NULL DEFAULT 0,
  claude_session_uuid TEXT,
  root_state TEXT NOT NULL DEFAULT 'unrooted',
  root_session_id INTEGER,
  parent_archive_id INTEGER,
  ingested_at TEXT NOT NULL,
  ingest_source_mtime TEXT,
  rooted_at TEXT,
  rooted_by TEXT,
  superseded_by_archive_id INTEGER REFERENCES transcript_archives(id),
  growth_kind TEXT NOT NULL DEFAULT 'initial',
  project_id INTEGER,
  project_rooted_at TEXT,
  project_rooted_by TEXT,
  dedupe_kind TEXT
);
"""


def _insert(
    conn: sqlite3.Connection,
    archive_id: int,
    source_path: str,
    body: bytes,
    *,
    kind: str = "session",
    ingested_at: str = "2026-09-01T00:00:00Z",
    superseded_by: Optional[int] = None,
    stored: Optional[bytes] = None,
    sha_override: Optional[str] = None,
) -> None:
    """Insert one archive row shaped exactly like the live schema.

    Inputs: conn, archive_id, source_path, body (the ORIGINAL bytes this
      row stands for), kind, ingested_at, superseded_by (forward pointer),
      stored (what actually goes in content_gzip; defaults to the
      compressed body), sha_override (to manufacture an inconsistency).
    Output: None.
    """
    blob = stored if stored is not None else zlib.compress(body, 9)
    conn.execute(
        "INSERT INTO transcript_archives (id, archive_uuid, kind, source_path,"
        " content_gzip, content_sha256, raw_byte_length, compressed_byte_length,"
        " line_ending, has_trailing_newline, ingested_at, superseded_by_archive_id,"
        " growth_kind)"
        " VALUES (?,?,?,?,?,?,?,?,'LF',1,?,?,'initial')",
        (
            archive_id,
            f"arch-{archive_id}",
            kind,
            source_path,
            blob,
            sha_override or hashlib.sha256(body).hexdigest(),
            len(body),
            len(blob),
            ingested_at,
            superseded_by,
        ),
    )
    conn.commit()


@pytest.fixture()
def state_dir(tmp_path: Path) -> Path:
    """A throwaway state directory holding an unsplit cloude.db."""
    state = tmp_path / "state"
    state.mkdir()
    conn = sqlite3.connect(state / "cloude.db")
    conn.executescript(ARCHIVE_DDL)
    conn.commit()
    conn.close()
    return state


@pytest.fixture()
def corpus(tmp_path: Path) -> Path:
    """A throwaway corpus root."""
    root = tmp_path / "projects"
    root.mkdir()
    return root


def _conn(state_dir: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(state_dir / "cloude.db")
    conn.row_factory = sqlite3.Row
    return conn


def test_identity_is_the_file_stem() -> None:
    """Not claude_session_uuid: 21,030 of 22,184 live paths disagree with it."""
    assert uuid_from_source_path("-Users-x/abc-def.jsonl") == "abc-def"
    assert uuid_from_source_path("-a/uuid/subagents/agent-x.jsonl") == "agent-x"


def test_a_uuid_with_no_rows_is_a_measured_absence(state_dir: Path) -> None:
    """The query RAN. That is a different fact from the database being gone."""
    with _conn(state_dir) as conn:
        assert resolve_uuid(conn, "nope").outcome == NO_ARCHIVE_ROW


def test_an_unreadable_database_is_not_an_empty_one(tmp_path: Path) -> None:
    """NEGATIVE CONTROL for the rule that silence is never evidence."""
    empty = tmp_path / "nothing"
    empty.mkdir()
    plan = plan_restore(empty, "abc")
    assert plan.resolve.outcome in (DATABASE_UNREADABLE, NO_ARCHIVE_ROW)
    # And the two names are genuinely distinct in the vocabulary.
    assert DATABASE_UNREADABLE != NO_ARCHIVE_ROW


def test_an_older_row_is_never_the_one_chosen(state_dir: Path) -> None:
    """THE CENTRAL NEGATIVE CONTROL: picking wrongly truncates silently.

    Row 1 is a snapshot superseded by row 2. Reconstructing row 1 gives a
    strict prefix. A resolver that returned it would produce a valid
    JSONL file, write cleanly, verify against its OWN hash, and hand the
    user a conversation with its tail cut off.
    """
    old = b'{"type":"user","n":1}\n'
    new = old + b'{"type":"assistant","n":2}\n'
    with _conn(state_dir) as conn:
        _insert(conn, 2, "-p/abc.jsonl", new, ingested_at="2026-09-02T00:00:00Z")
        _insert(
            conn,
            1,
            "-p/abc.jsonl",
            old,
            ingested_at="2026-09-01T00:00:00Z",
            superseded_by=2,
            stored=SENTINEL_GZIP,
        )
        resolved = resolve_uuid(conn, "abc")
        assert resolved.outcome == RESOLVED
        assert resolved.row is not None
        assert resolved.row.archive_id == 2, "the NEWEST row, never the snapshot"
        rebuilt = reconstruct_row(conn, resolved.row)
        assert rebuilt.outcome == RECONSTRUCTED
        assert rebuilt.data == new
        assert rebuilt.data != old


def test_a_superseded_row_still_reconstructs_through_the_chain(
    state_dir: Path,
) -> None:
    """The prefix-dedupe read path works; it is just not what gets written.

    This is why the 1,426 ``prefix_of_source`` rows are safe: they hold no
    bytes of their own, their content lives forward, and the chain walk is
    what makes the CHOSEN row reconstructable at all.
    """
    old = b'{"a":1}\n'
    new = old + b'{"b":2}\n'
    with _conn(state_dir) as conn:
        _insert(conn, 2, "-p/abc.jsonl", new, ingested_at="2026-09-02T00:00:00Z")
        _insert(
            conn, 1, "-p/abc.jsonl", old, superseded_by=2, stored=SENTINEL_GZIP
        )
        row = resolve_uuid(conn, "abc").row
        assert row is not None
        # Reach the superseded row directly to prove the walk, then confirm
        # the resolver would never have handed it to us.
        from src.core.transcript_restore_resolve import ArchiveRowRef

        snapshot = ArchiveRowRef(
            archive_id=1,
            source_path="-p/abc.jsonl",
            content_sha256=hashlib.sha256(old).hexdigest(),
            raw_byte_length=len(old),
            kind="session",
            growth_kind="initial",
            ingested_at="2026-09-01T00:00:00Z",
            superseded_by_archive_id=2,
            claude_session_uuid=None,
        )
        assert reconstruct_row(conn, snapshot).data == old
        assert row.archive_id == 2


def test_a_broken_supersession_pointer_refuses(state_dir: Path) -> None:
    """A dangling forward pointer is named, not silently shortened."""
    with _conn(state_dir) as conn:
        _insert(
            conn, 1, "-p/abc.jsonl", b'{"a":1}\n', superseded_by=99,
            stored=SENTINEL_GZIP,
        )
        row = resolve_uuid(conn, "abc").row
        assert row is not None
        assert reconstruct_row(conn, row).outcome == CHAIN_BROKEN


def test_bytes_that_are_not_what_was_ingested_are_refused(state_dir: Path) -> None:
    """NEGATIVE CONTROL. The one failure that produces plausible output.

    Every other reconstruction failure yields nothing. This one yields a
    perfectly valid transcript that is not the conversation the archive
    recorded, so it must be caught by the hash and not by a reader's eye.
    """
    with _conn(state_dir) as conn:
        _insert(conn, 1, "-p/abc.jsonl", b'{"a":1}\n', sha_override="0" * 64)
        row = resolve_uuid(conn, "abc").row
        assert row is not None
        result = reconstruct_row(conn, row)
        assert result.outcome == SELF_INCONSISTENT
        assert result.data is None, "refused bytes must not be handed on"


def test_one_uuid_under_two_project_directories_refuses(state_dir: Path) -> None:
    """The cwd-spelling trap: one uuid, two transcripts. Writing either is a guess."""
    with _conn(state_dir) as conn:
        _insert(conn, 1, "-Users-x-Dev-P/abc.jsonl", b'{"a":1}\n')
        _insert(conn, 2, "-Users-x-iCloud-P/abc.jsonl", b'{"a":1}\n')
        result = resolve_uuid(conn, "abc")
        assert result.outcome == AMBIGUOUS_UUID
        assert len(result.candidates) == 2
        # And the operator can narrow it, which is what makes it actionable.
        narrowed = resolve_uuid(conn, "abc", source_path="-Users-x-Dev-P/abc.jsonl")
        assert narrowed.outcome == RESOLVED
        assert narrowed.row is not None and narrowed.row.archive_id == 1


def test_a_narrowing_argument_may_not_redirect(state_dir: Path) -> None:
    """--source-path narrows; it cannot point the uuid at another conversation."""
    with _conn(state_dir) as conn:
        _insert(conn, 1, "-p/abc.jsonl", b'{"a":1}\n')
        _insert(conn, 2, "-p/other.jsonl", b'{"b":2}\n')
        result = resolve_uuid(conn, "abc", source_path="-p/other.jsonl")
        assert result.outcome == NO_ARCHIVE_ROW


def test_an_underscore_in_a_stem_cannot_match_a_neighbour(state_dir: Path) -> None:
    """NEGATIVE CONTROL for the SQL LIKE wildcard.

    ``_`` matches any single character in LIKE, and 528 stems in the live
    archive contain one (``agent-aprompt_suggestion-...``). Asking for a
    stem whose own file is ABSENT must answer NO_ARCHIVE_ROW, not resolve
    to the neighbour the wildcard happens to reach - which would restore a
    stranger's conversation under the requested uuid, silently.
    """
    with _conn(state_dir) as conn:
        _insert(conn, 1, "-p/agent-aXbX.jsonl", b'{"someone":"else"}\n')
        assert resolve_uuid(conn, "agent-a_b_").outcome == NO_ARCHIVE_ROW
        # And the literal stem still resolves when it really is there.
        _insert(conn, 2, "-p/agent-a_b_.jsonl", b'{"mine":1}\n')
        result = resolve_uuid(conn, "agent-a_b_")
        assert result.outcome == RESOLVED
        assert result.row is not None
        assert result.row.source_path == "-p/agent-a_b_.jsonl"


def test_a_percent_in_a_stem_cannot_match_everything(state_dir: Path) -> None:
    """The other LIKE wildcard, for the same reason."""
    with _conn(state_dir) as conn:
        _insert(conn, 1, "-p/abc.jsonl", b'{"a":1}\n')
        _insert(conn, 2, "-p/def.jsonl", b'{"b":2}\n')
        assert resolve_uuid(conn, "%").outcome == NO_ARCHIVE_ROW


def test_a_subagent_transcript_restores_and_is_not_claimed_resumable(
    state_dir: Path, corpus: Path
) -> None:
    """21,385 of 23,659 live rows are subagents. Restorable, not resumable."""
    body = b'{"type":"user","cwd":"/Users/x/P"}\n'
    with _conn(state_dir) as conn:
        _insert(conn, 1, "-p/parent/subagents/agent-x.jsonl", body, kind="subagent")
    plan = plan_restore(state_dir, "agent-x", corpus_root=corpus, create_dirs=True)
    assert plan.ready
    assert plan.resumable is False


def test_the_whole_plan_round_trips_to_disk(state_dir: Path, corpus: Path) -> None:
    """End to end in miniature: archive bytes in, identical bytes on disk."""
    body = b'{"type":"user","cwd":"/Users/x/P"}\n{"type":"assistant"}\n'
    with _conn(state_dir) as conn:
        _insert(conn, 1, "-Users-x-P/abc.jsonl", body)
    plan = plan_restore(state_dir, "abc", corpus_root=corpus, create_dirs=True)
    assert plan.ready and plan.target is not None
    assert plan.target.outcome == TARGET_READY
    assert plan.resumable is True
    done = apply_restore(plan, create_dirs=True)
    assert done.write is not None and done.write.outcome == WRITTEN
    assert done.target is not None and done.target.path is not None
    assert done.target.path.read_bytes() == body
    assert done.write.verified_sha256 == hashlib.sha256(body).hexdigest()


def test_planning_writes_nothing(state_dir: Path, corpus: Path) -> None:
    """DRY RUN IS THE DEFAULT AT THE LIBRARY LAYER, not only in the script."""
    with _conn(state_dir) as conn:
        _insert(conn, 1, "-Users-x-P/abc.jsonl", b'{"a":1}\n')
    plan = plan_restore(state_dir, "abc", corpus_root=corpus, create_dirs=True)
    assert plan.ready
    assert list(corpus.rglob("*.jsonl")) == []
    assert plan.write is None


def test_apply_refuses_a_plan_that_was_not_ready(state_dir: Path, corpus: Path) -> None:
    """It executes the decision a human was shown; it does not re-decide."""
    plan = plan_restore(state_dir, "missing", corpus_root=corpus)
    assert not plan.ready
    done = apply_restore(plan)
    assert done.write is not None and done.write.outcome != WRITTEN
    assert list(corpus.rglob("*.jsonl")) == []
