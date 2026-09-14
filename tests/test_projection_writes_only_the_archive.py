"""The projection writes the archive file and holds no lock on cloude.db.

TWO CLAIMS, AND THEY FAIL DIFFERENTLY.

LOCK SCOPE is the defect this change fixes. ``BEGIN IMMEDIATE`` takes the
write lock on every attached database, so a projection running on a
cloude.db connection with the archive attached held CLOUDE.DB's write
lock for the length of every transcript. Measured on live: a main-only
``BEGIN IMMEDIATE`` on cloude.db blocked 63,927 ms, the event loop parked
in ``claude_event_hook`` for 25 s at a time, and the app's own corpus
ingest pass died at 18:57:00Z with ``database is locked``.

DESTINATION is the failure that could HIDE. A projection pointed at the
wrong file as main still runs, still reports ``status=ok``, and creates
its own ``message_*`` tables in whatever file it opened - which is the
shadowing defect this branch already paid for once at the DDL. So the
test checks WHERE the rows are, not that the pass returned ok.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_pw_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_pw_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.archive_db_partition import ARCHIVE_DB_FILENAME
from src.core.db import connect_archive_only, db_path_for, transaction


def _split_state(tmp_path: Path) -> Path:
    """A state dir with a real cloude.db and a real cloude-archive.db.

    Inputs: tmp_path (Path).
    Output: Path - the state directory.
    """
    state = tmp_path / "state"
    state.mkdir()
    c = sqlite3.connect(db_path_for(state))
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY, activity_state TEXT)")
    c.execute("INSERT INTO sessions(activity_state) VALUES ('idle')")
    c.commit()
    c.close()
    a = sqlite3.connect(state / ARCHIVE_DB_FILENAME)
    a.execute("PRAGMA journal_mode=WAL")
    a.execute("CREATE TABLE message_transcripts (id INTEGER PRIMARY KEY, v TEXT)")
    a.commit()
    a.close()
    return state


def test_a_projection_write_does_not_lock_cloude_db(tmp_path: Path) -> None:
    """THE REGRESSION. The hook path must keep writing while the archive is written.

    A long write is held open on the projection's connection. A
    main-only write to cloude.db - exactly what
    ``_persist_activity_state`` does on the event loop - must complete
    anyway. On the old shape it waited out ``busy_timeout``.
    """
    state = _split_state(tmp_path)
    open_now = threading.Event()
    release = threading.Event()

    def long_archive_write() -> None:
        """Hold a projection-shaped transaction open on the archive."""
        conn = connect_archive_only(state)
        with transaction(conn):
            conn.execute("INSERT INTO message_transcripts(v) VALUES ('x')")
            open_now.set()
            release.wait(10)
        conn.close()

    t = threading.Thread(target=long_archive_write)
    t.start()
    try:
        assert open_now.wait(10), "the projection write never opened"
        app = sqlite3.connect(db_path_for(state), isolation_level=None, timeout=30)
        app.execute("PRAGMA busy_timeout=1500")
        started = time.monotonic()
        app.execute("BEGIN IMMEDIATE")
        app.execute("UPDATE sessions SET activity_state = 'working'")
        app.execute("COMMIT")
        elapsed = (time.monotonic() - started) * 1000
        app.close()
        assert elapsed < 1000, (
            f"the hook path's write to cloude.db waited {elapsed:.0f} ms on a "
            f"projection transaction, so the projection is holding cloude.db's "
            f"write lock again"
        )
    finally:
        release.set()
        t.join(10)


def test_the_projection_connection_opens_the_archive_as_main(
    tmp_path: Path,
) -> None:
    """DESTINATION. main IS the archive file, and cloude.db is not attached."""
    state = _split_state(tmp_path)
    conn = connect_archive_only(state)
    try:
        rows = list(conn.execute("PRAGMA database_list"))
        schemas = {r[1]: r[2] for r in rows}
        assert set(schemas) == {"main"}, schemas
        assert Path(schemas["main"]).name == ARCHIVE_DB_FILENAME
    finally:
        conn.close()


def test_cloude_db_gains_no_message_tables_and_does_not_grow(
    tmp_path: Path,
) -> None:
    """THE ONE THAT CAN HIDE. A wrong-file projection still reports ok.

    Rows must land in the archive, and cloude.db must be untouched -
    byte-identical, and carrying no ``message_*`` table of its own. A
    pass that created a second set of tables in main would return
    ``status=ok`` and quietly split the model across two files, which is
    exactly the shadowing this branch already fixed once.
    """
    state = _split_state(tmp_path)
    main = db_path_for(state)
    before_size = main.stat().st_size
    before_tables = {
        r[0] for r in sqlite3.connect(main).execute(
            "SELECT name FROM sqlite_master WHERE type='table'")
    }

    conn = connect_archive_only(state)
    with transaction(conn):
        for i in range(200):
            conn.execute("INSERT INTO message_transcripts(v) VALUES (?)", (str(i),))
    conn.close()

    # The rows are in the ARCHIVE file, read directly, not through any attach.
    arch = sqlite3.connect(state / ARCHIVE_DB_FILENAME)
    assert arch.execute("SELECT count(*) FROM message_transcripts").fetchone()[0] == 200
    arch.close()

    after_tables = {
        r[0] for r in sqlite3.connect(main).execute(
            "SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert after_tables == before_tables, (
        f"cloude.db gained tables: {sorted(after_tables - before_tables)}"
    )
    assert not any(t.startswith("message_") for t in after_tables), sorted(after_tables)
    assert main.stat().st_size == before_size, (
        "cloude.db changed size during a projection that should never touch it"
    )
