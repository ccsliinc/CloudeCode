"""The ingest pass routes writes off cloude.db's lock, and the routing is asserted.

THE FAILURE THIS GUARDS IS INVISIBLE TO EVERY RESULT-BASED TEST. Routing
an archive write onto the connection that also holds cloude.db produces
the right rows, the right counts and the right report. What it also does
is take cloude.db's write lock for the length of the write, and cloude.db
is where ``claude_event_hook`` writes ``sessions.activity_state``
synchronously on the event loop. Measured 2026-09-14 during a 97 s ingest
pass: three stalls inside 33 seconds, the loop parked 25 s at a time,
py-spy showing it in ``transaction -> _persist_activity_state ->
record_hook_event -> claude_event_hook``.

So these tests assert WHICH CONNECTION each path holds, not what it
produced. A test that checked only the rows would pass on the broken
routing forever.

AND ROOTING KEEPS BOTH FILES. It joins transcript_archives to sessions
and projects, so an archive-only connection would make it stop finding
the rows it exists to join. That asymmetry is the whole design and it is
asserted in both directions.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_icr_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_icr_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.archive_db_partition import ARCHIVE_DB_FILENAME
from src.core.db import connect, connect_archive_only, db_path_for
from src.core.db_connection_shape import (
    APP_ONLY,
    APP_ONLY_SPLIT,
    ARCHIVE_ONLY,
    PAIR,
    ConnectionShapeError,
    connection_shape,
    require_archive_only,
    require_pair,
)


def _split(tmp_path: Path) -> Path:
    """A state dir with both files present."""
    state = tmp_path / "state"
    state.mkdir()
    c = sqlite3.connect(db_path_for(state))
    c.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY)")
    c.commit(); c.close()
    a = sqlite3.connect(state / ARCHIVE_DB_FILENAME)
    a.execute("CREATE TABLE transcript_archives (id INTEGER PRIMARY KEY)")
    a.commit(); a.close()
    return state


def _unsplit(tmp_path: Path) -> Path:
    """A state dir with cloude.db only, as an install that never split."""
    state = tmp_path / "unsplit"
    state.mkdir()
    c = sqlite3.connect(db_path_for(state))
    c.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY)")
    c.execute("CREATE TABLE transcript_archives (id INTEGER PRIMARY KEY)")
    c.commit(); c.close()
    return state


def test_the_three_shapes_are_told_apart_by_the_filesystem(
    tmp_path: Path,
) -> None:
    """A main-only connection means different things on the two installs.

    Same attached set, different fact: on an unsplit install it is the
    whole datastore, on a split one it is cloude.db with the archive
    deliberately left out. Collapsing them would let an archive write be
    routed onto cloude.db's lock and pass.
    """
    split, unsplit = _split(tmp_path), _unsplit(tmp_path)

    arch = connect_archive_only(split)
    pair = connect(db_path_for(split), create=False)
    lone = connect(db_path_for(split), create=False, attach_archive=False)
    solo = connect(db_path_for(unsplit), create=False)
    try:
        assert connection_shape(arch) == ARCHIVE_ONLY
        assert connection_shape(pair) == PAIR
        assert connection_shape(lone) == APP_ONLY_SPLIT
        assert connection_shape(solo) == APP_ONLY
    finally:
        for c in (arch, pair, lone, solo):
            c.close()


def test_a_write_pointed_at_the_pair_is_refused(tmp_path: Path) -> None:
    """THE CONTROL. The wrong connection must be caught, not tolerated.

    This is the exact mistake the split exists to prevent, and it is the
    one that produces correct output while re-creating the stall.
    """
    state = _split(tmp_path)
    pair = connect(db_path_for(state), create=False)
    try:
        with pytest.raises(ConnectionShapeError) as caught:
            require_archive_only(pair, "ingest_one")
        assert "cloude.db's write lock" in str(caught.value)
    finally:
        pair.close()


def test_rooting_is_refused_on_an_archive_only_connection(
    tmp_path: Path,
) -> None:
    """THE OTHER DIRECTION, and it is not symmetric by accident.

    Rooting joins across the two files. On an archive-only connection the
    join would resolve against one file and root nothing, while reporting
    ``status: ran`` - which is precisely the "rooted nothing" that this
    project's own rule says must never be confusable with "did not look".
    """
    state = _split(tmp_path)
    arch = connect_archive_only(state)
    try:
        with pytest.raises(ConnectionShapeError) as caught:
            require_pair(arch, "root_pending_archives")
        assert "joins across" in str(caught.value)
    finally:
        arch.close()


def test_an_unsplit_install_satisfies_both_requirements(
    tmp_path: Path,
) -> None:
    """THE POSITIVE CONTROL. One file, one lock, nothing to route.

    Without this, a guard that refused everything would satisfy both
    refusal tests above and break every install that never split.
    """
    state = _unsplit(tmp_path)
    conn = connect(db_path_for(state), create=False)
    try:
        require_archive_only(conn, "ingest_one")
        require_pair(conn, "root_pending_archives")
    finally:
        conn.close()


def test_the_ingest_pass_asserts_its_routing_at_the_seam() -> None:
    """The guards are actually CALLED, not merely available.

    A helper nothing invokes is the shape of safety, not safety. Read
    from the source because the alternative is running a full ingest
    pass to observe an exception that should never fire.
    """
    src = (ROOT / "src" / "core" / "corpus_ingest_service.py").read_text()
    assert 'require_pair(conn, "the corpus ingest pass' in src
    assert 'require_archive_only(archive_conn, "the corpus ingest pass' in src
    # The heavy write and the per-file hash go to the archive connection.
    assert "ingest_one(archive_conn, entry)" in src
    assert "_current_hash(archive_conn, entry.source_path)" in src
    # Rooting keeps the pair.
    assert "root_pending_archives(conn)" in src


def test_rooting_still_has_its_named_skip_state() -> None:
    """A skipped rooting pass stays a NAMED outcome, never bare zeros.

    The split adds a new way for the pass to be arranged differently, so
    the rule it could erode is asserted here rather than assumed.
    """
    src = (ROOT / "src" / "core" / "corpus_ingest_service.py").read_text()
    assert '"status": "skipped_unchanged"' in src
    assert '"status": "ran", **root_pending_archives(conn)' in src


def test_a_misrouted_write_raises_at_runtime_not_only_in_review(
    tmp_path: Path,
) -> None:
    """THE RUNTIME CONTROL, and it is stronger than the source check above.

    The guard sits inside ``ingest_one``, so it fires on the connection
    that function was actually HANDED. A caller that routes the write
    onto the pair is caught when it runs, not only when someone greps
    the seam - and greps are what the earlier test does, because it
    cannot run a full pass.
    """
    from src.core.transcript_corpus_ingest import ingest_one

    state = _split(tmp_path)
    pair = connect(db_path_for(state), create=False)
    try:
        with pytest.raises(ConnectionShapeError) as caught:
            ingest_one(pair, object())
        assert "ingest_one" in str(caught.value)
    finally:
        pair.close()


def test_rooting_raises_at_runtime_on_the_wrong_connection(
    tmp_path: Path,
) -> None:
    """The same, the other way: rooting handed an archive-only connection."""
    from src.core.transcript_corpus_ingest import root_pending_archives

    state = _split(tmp_path)
    arch = connect_archive_only(state)
    try:
        with pytest.raises(ConnectionShapeError) as caught:
            root_pending_archives(arch)
        assert "root_pending_archives" in str(caught.value)
    finally:
        arch.close()
