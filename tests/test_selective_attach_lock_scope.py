"""Only connections that read the archive attach it, and the ones that need it still get it.

WHY THIS EXISTS, MEASURED RATHER THAN REASONED.

``BEGIN IMMEDIATE`` acquires the write lock on EVERY ATTACHED DATABASE,
not only on the one the statements touch. So a connection that writes one
row to ``sessions`` in cloude.db, while holding cloude-archive.db
attached, waits for whatever is writing the archive. Isolated, identical
write both ways, with another writer holding the attached file: 1.1 ms
unattached against 3,772.1 ms attached.

That is what made the UI die. ``claude_event_hook`` runs SYNCHRONOUSLY ON
THE EVENT LOOP and its ``_persist_activity_state`` takes one of these
transactions. With 19 live panes firing hooks and the corpus drain
writing the archive, py-spy caught the loop parked in
``transaction -> _persist_activity_state -> record_hook_event ->
claude_event_hook`` while a request beside it timed out at 30.04 s, which
is ``busy_timeout=30000`` expiring to the millisecond.

THE NEGATIVE CONTROL IS THE WHOLE TEST. A selective attach that quietly
stopped attaching for a reader that NEEDS the archive would pass every
latency test anyone can write and break the archive surface silently, so
the tests that matter here are the ones proving the archive still
resolves, and the one proving a connection that cannot see the archive
REFUSES to answer questions about it rather than answering "no".
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_sa_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_sa_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.archive_db_partition import ARCHIVE_DB_FILENAME, ARCHIVE_SCHEMA
from src.core.archive_db_attach import attached_schemas
from src.core.db import (
    ArchiveNotAttachedError,
    connect,
    db_path_for,
    table_exists,
    transaction,
)


def _pair(tmp_path: Path) -> Path:
    """Build a state dir holding a cloude.db and a cloude-archive.db.

    Inputs: tmp_path (Path).
    Output: Path - the state directory.
    """
    state = tmp_path / "state"
    state.mkdir()
    main = db_path_for(state)
    c = sqlite3.connect(main)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY, title TEXT)")
    c.execute("INSERT INTO sessions(title) VALUES ('a')")
    c.commit()
    c.close()
    arch = state / ARCHIVE_DB_FILENAME
    a = sqlite3.connect(arch)
    a.execute("PRAGMA journal_mode=WAL")
    a.execute("CREATE TABLE transcript_archives (id INTEGER PRIMARY KEY, v TEXT)")
    a.execute("INSERT INTO transcript_archives(v) VALUES ('x')")
    a.commit()
    a.close()
    return state


# ---------------------------------------------------------------------------
# The mechanism
# ---------------------------------------------------------------------------


def test_begin_immediate_takes_the_lock_on_every_attached_database(
    tmp_path: Path,
) -> None:
    """THE MEASUREMENT THE WHOLE CHANGE RESTS ON.

    A write that touches ONLY main still waits for an archive writer,
    when the archive is attached. Same write, same file, both ways.
    """
    state = _pair(tmp_path)
    arch = state / ARCHIVE_DB_FILENAME
    held = threading.Event()
    release = threading.Event()

    def hold_the_archive() -> None:
        """Hold a write transaction open on the archive."""
        c = sqlite3.connect(arch, timeout=30)
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("BEGIN IMMEDIATE")
        c.execute("INSERT INTO transcript_archives(v) VALUES ('held')")
        held.set()
        release.wait(10)
        c.execute("COMMIT")
        c.close()

    def main_only_write(attach: bool) -> bool:
        """True when the write completed, False when it timed out."""
        conn = connect(db_path_for(state), create=False, attach_archive=attach)
        conn.execute("PRAGMA busy_timeout=700")
        try:
            with transaction(conn):
                conn.execute("INSERT INTO sessions(title) VALUES ('w')")
            return True
        except sqlite3.OperationalError:
            return False
        finally:
            conn.close()

    t = threading.Thread(target=hold_the_archive)
    t.start()
    assert held.wait(10), "the holder never took the archive lock"
    try:
        # UNATTACHED: unaffected by an archive writer.
        assert main_only_write(attach=False) is True
        # ATTACHED: blocked by it, on a write that never names the archive.
        assert main_only_write(attach=True) is False, (
            "BEGIN IMMEDIATE no longer takes the attached database's lock, "
            "so the reason this flag exists has gone away; re-measure "
            "before deleting it"
        )
    finally:
        release.set()
        t.join(10)


# ---------------------------------------------------------------------------
# The negative controls: what still needs the archive must still get it
# ---------------------------------------------------------------------------


def test_a_connection_that_needs_the_archive_still_gets_it(
    tmp_path: Path,
) -> None:
    """THE CONTROL THAT MATTERS. The default is unchanged and still attaches."""
    state = _pair(tmp_path)
    conn = connect(db_path_for(state), create=False)
    try:
        assert ARCHIVE_SCHEMA in attached_schemas(conn)
        assert table_exists(conn, "transcript_archives") is True
        assert conn.execute(
            "SELECT count(*) FROM transcript_archives"
        ).fetchone()[0] == 1
    finally:
        conn.close()


def test_an_unattached_connection_refuses_rather_than_denying(
    tmp_path: Path,
) -> None:
    """A misclassified caller fails LOUDLY. It must never answer "absent".

    Answering False here is the ``model_absent`` defect: identical to a
    datastore that genuinely has no archive, and impossible to tell apart
    downstream. That silent answer is what a selective attach would
    otherwise reintroduce, so it raises instead.
    """
    state = _pair(tmp_path)
    conn = connect(db_path_for(state), create=False, attach_archive=False)
    try:
        assert ARCHIVE_SCHEMA not in attached_schemas(conn)
        # App-side questions are still answerable and still answered.
        assert table_exists(conn, "sessions") is True
        with pytest.raises(ArchiveNotAttachedError):
            table_exists(conn, "transcript_archives")
    finally:
        conn.close()


def test_the_hot_path_helpers_open_main_only() -> None:
    """The two helpers the hook path and the listing pass use.

    cdac607 changed 25 call sites and NOT these two, and said in its own
    message that it did not reach the hot path. These are the hot path:
    the hook route's activity write goes through the second one.
    """
    source = (ROOT / "src" / "core" / "session_manager.py").read_text()
    for helper in ("_datastore_connection", "_writable_datastore_connection"):
        start = source.index(f"def {helper}(self)")
        body = source[start:start + 2200]
        assert "attach_archive=False" in body, (
            f"{helper} attaches the archive again, so every BEGIN IMMEDIATE "
            f"under it takes the archive's write lock on the event loop"
        )


def test_no_archive_file_is_a_real_answer_not_a_refusal(tmp_path: Path) -> None:
    """THE CASE THAT BROKE 615 TESTS, pinned so it cannot come back.

    An unsplit install genuinely has no ``message_transcripts``, and
    ``apply_message_model_schema`` asks exactly that before creating it.
    Conditioning the refusal on "the archive schema is not attached"
    rather than on "an archive file exists and was not attached" turns
    every fresh migration into a hard failure.
    """
    state = tmp_path / "unsplit"
    state.mkdir()
    main = db_path_for(state)
    c = sqlite3.connect(main)
    c.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY)")
    c.commit()
    c.close()
    assert not (state / ARCHIVE_DB_FILENAME).exists()

    for attach in (True, False):
        conn = connect(main, create=False, attach_archive=attach)
        try:
            # No raise, and the honest answer, on BOTH kinds of connection.
            assert table_exists(conn, "message_transcripts") is False
        finally:
            conn.close()
