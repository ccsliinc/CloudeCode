"""The read-only enforcement tests for the conversation-archive viewer.

Separate file because these are the load-bearing ones. The archive is a
multi-gigabyte database written live by ingestion hooks; the viewer must be
incapable of touching it, not merely disinclined to. A convention that says
"we only do GETs" is not a control, so this file proves the control.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

# ---- env bootstrap so ``src.config`` import succeeds --------------------
# src.config exits the process when TOTP/JWT secrets are absent, so these
# must be set BEFORE the first src.* import. Same pattern as
# tests/test_upload_file.py.
import os
import sys
import tempfile

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_hist_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_hist_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402

from tests.history_fixture import enabled_config, seed_fixture_db

HAS_ARCHIVE = (
    importlib.util.find_spec("sqlalchemy") is not None
    and importlib.util.find_spec("claude_history") is not None
)
pytestmark = pytest.mark.skipif(
    not HAS_ARCHIVE,
    reason="optional sqlalchemy / claude_history packages are not installed",
)


def test_insert_through_the_viewer_engine_raises(tmp_path: Path) -> None:
    """An INSERT on the viewer's engine must FAIL, not silently succeed.

    This is the assertion the whole read-only claim rests on. It exercises
    the real engine builder, not a mock, so a future change that drops
    ``mode=ro`` or the ``query_only`` pragma fails here.
    """
    from sqlalchemy import text as sa_text
    from sqlalchemy.exc import DatabaseError, OperationalError

    from src.core.history_db import get_engine, reset_engine_cache

    db_path = tmp_path / "ro.db"
    seed_fixture_db(db_path)
    reset_engine_cache()
    try:
        engine = get_engine(enabled_config(db_path))
        with engine.connect() as connection:
            with pytest.raises((OperationalError, DatabaseError)):
                connection.execute(
                    sa_text(
                        "INSERT INTO hosts (machine_id, first_seen_at) "
                        "VALUES ('intruder', '2026-01-01 00:00:00')"
                    )
                )
                connection.commit()
    finally:
        reset_engine_cache()

    # And prove nothing landed, through a fresh handle.
    import sqlite3

    with sqlite3.connect(str(db_path)) as raw:
        assert (
            raw.execute(
                "SELECT count(*) FROM hosts WHERE machine_id = 'intruder'"
            ).fetchone()[0]
            == 0
        )


def test_update_and_delete_also_raise(tmp_path: Path) -> None:
    """Read-only means every write verb, not just INSERT."""
    from sqlalchemy import text as sa_text
    from sqlalchemy.exc import DatabaseError, OperationalError

    from src.core.history_db import get_engine, reset_engine_cache

    db_path = tmp_path / "ro2.db"
    seed_fixture_db(db_path)
    reset_engine_cache()
    try:
        engine = get_engine(enabled_config(db_path))
        with engine.connect() as connection:
            for statement in (
                "UPDATE sessions SET cwd = '/hacked'",
                "DELETE FROM messages",
                "DROP TABLE compaction_events",
            ):
                with pytest.raises((OperationalError, DatabaseError)):
                    connection.execute(sa_text(statement))
                connection.rollback()
    finally:
        reset_engine_cache()


def test_query_only_pragma_is_set_on_every_connection(tmp_path: Path) -> None:
    """The pragma is pinned by the connect event, not by one lucky call."""
    from sqlalchemy import text as sa_text

    from src.core.history_db import get_engine, reset_engine_cache

    db_path = tmp_path / "ro3.db"
    seed_fixture_db(db_path)
    reset_engine_cache()
    try:
        engine = get_engine(enabled_config(db_path))
        for _ in range(3):
            with engine.connect() as connection:
                assert connection.execute(sa_text("PRAGMA query_only")).scalar() == 1
    finally:
        reset_engine_cache()


def test_engine_url_is_mode_ro_and_not_immutable(tmp_path: Path) -> None:
    """``mode=ro`` is present and ``immutable`` is absent, deliberately.

    ``immutable=1`` on a live WAL database serves a pre-WAL snapshot with
    no error, which is a stale read dressed as a current one.
    """
    from src.core.history_db import _sqlite_ro_url

    url = _sqlite_ro_url("/tmp/x.db")
    assert "mode=ro" in url
    assert "immutable" not in url


def test_router_defines_get_handlers_only() -> None:
    """Structural check: the history router exposes no write verbs."""
    from src.api.history import router

    for route in router.routes:
        assert set(route.methods) <= {"GET", "HEAD"}, route.path
