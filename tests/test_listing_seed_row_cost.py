"""What the status seed's row read costs on ``GET /sessions/list``.

WHY THIS FILE EXISTS. The listing round removed the two per-session tmux
SUBPROCESSES from this pass (``tests/test_listing_subprocess_cost.py``)
and the per-row CONNECTION storm from ``/sessions/attachable`` (same
file). Neither covers the same storm on ``/sessions/list``, which is a
different reader on a different route: the status seed ladder's
``session_status_seed_read.read_instance_row`` opened its OWN SQLite
connection, per session, to read four columns off the row found by the
SAME instance triple the attachable index already keys on.

THE COST IS A BURST, NOT A DRIP, and saying so accurately matters.
``seeded_display`` re-derives at most once per
``SEED_REFRESH_INTERVAL_SECONDS`` (60s) per session and serves a cache in
between, so on a 5s poll only about one poll in twelve reaches the read at
all. But the seeds are warmed together and therefore EXPIRE together, so
the real shape is N synchronous connection opens landing inside ONE pass -
which is what a p99 is made of. Measured on live 2026-09-10 with 19
sessions, ``GET /api/v1/sessions/list`` read p50 270.1 ms against p99
418.5 ms, and a no-op ``/health`` inflated from p50 45.3 ms quiet to
181.9 ms while a listing was in flight, capping at 224 ms. A no-op
inflating fourfold and capping at roughly one listing pass is head-of-line
blocking, not slow work: this body is entirely synchronous inside
``async def list_session_infos``, so everything it spends is spent with
the event loop unable to read the tmux pipe, deliver a keystroke, or
answer anything else.

WHY THE READER IS MEASURED DIRECTLY RATHER THAN THROUGH A LIVE PASS. The
seed seam is reached only for a session that is measured LIVE and whose
status is still ``unknown`` - on live that is the majority (13 of 19 had
never fired a hook), but a throwaway pane built in a test is either a bare
shell (which resolves to ``idle`` and skips the seam) or a non-shell
command the bulk listing does not name (which resolves liveness to
``unknown`` and also skips it). A pass-level count on such a fixture would
report zero for the seed either way and would therefore pass whether or
not the fix was present. That is a test that cannot fail, which is worse
than no test. So the count is taken where the defect is: on the reader,
against a REAL migrated database and a REAL row.

THE NEGATIVE CONTROL IS SEPARATE AND LOAD-BEARING. A "fix" that answered
None for everything would open zero connections and pass a count
perfectly while blanking the status ladder. So the same row is read both
ways and the two answers must be identical, and an index that could not be
built must fall back to the connection rather than answer "no row".
"""

from __future__ import annotations

import os
import sys
import tempfile
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_lsr_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_lsr_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.session_instance_index import InstanceIndex, build_instance_index
from src.core.session_status_seed_read import read_instance_row
from tests.s7_helpers import migrated_connection

#: The socket every row in this file is scoped to. The index and the
#: per-row read must agree about it, because the stored triple is scoped
#: to the socket and a name is not unique across sockets.
SOCKET = "cloude_pytest_seedcost"

#: How many instances the reads are measured over. Small, but the claim
#: is about GROWTH: the per-row reader opens one connection each, the
#: index opens one for all of them.
INSTANCES = 4


class _CountingManager:
    """The two things ``read_instance_row`` asks a SessionManager for.

    Description: a real ``SessionManager`` is not needed here and would
        drag a tmux probe and a settings load into a test about SQLite.
        What the reader touches is exactly ``_writable_datastore_connection``
        and ``_tmux_socket_name``, so this provides both and counts the
        first. The connection handed back is a REAL migrated database, so
        the query under measurement is the production one.
    Inputs: db_path (Path) - the migrated cloude.db to open.
    Output: instances expose ``opens`` (int).
    Example: mgr = _CountingManager(path); mgr.opens
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self.opens = 0

    def _writable_datastore_connection(self):
        """Open the datastore, counting the open. Output: sqlite3.Connection."""
        from src.core.db import connect

        self.opens += 1
        return connect(str(self._db_path), create=False)

    def _tmux_socket_name(self) -> str:
        """The socket the stored triple is scoped to. Output: str."""
        return SOCKET


@pytest.fixture
def seeded_db(tmp_path):
    """A migrated cloude.db holding ``INSTANCES`` rows on one socket.

    Description: real rows through the real migration chain, each with a
        distinct value in every column the seed ladder reads, so a reader
        that returned the wrong row would be caught rather than agreeing
        with itself.
    Inputs: tmp_path.
    Output: tuple[Path, list[tuple[str, int]]] - the db path and the
        (tmux_name, epoch) keys written.
    Example: db_path, keys = seeded_db
    """
    state = tmp_path / "state"
    state.mkdir()
    keys: List[tuple] = []
    with closing(migrated_connection(state)) as conn:
        for index in range(INSTANCES):
            name = f"cloude_seedcost_{index}"
            epoch = 1_700_000_000 + index
            keys.append((name, epoch))
            conn.execute(
                "INSERT INTO sessions ("
                "  session_uuid, origin, created_at, updated_at, working_dir, "
                "  tmux_socket, tmux_name, tmux_created_epoch, "
                "  activity_state, activity_state_at, claude_session_uuid"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    f"uuid-{index}",
                    "created",
                    "2026-09-10T00:00:00Z",
                    "2026-09-10T00:00:00Z",
                    f"/tmp/proj-{index}",
                    SOCKET,
                    name,
                    epoch,
                    f"state-{index}",
                    f"2026-09-10T0{index}:00:00Z",
                    f"conv-{index}",
                ),
            )
        conn.commit()
        db_path = Path(conn.execute("PRAGMA database_list").fetchone()[2])
    return db_path, keys


def _index_for(db_path: Path, names) -> InstanceIndex:
    """Build the pass's one bulk index over these names.

    Inputs: db_path (Path). names (iterable[str]).
    Output: InstanceIndex.
    Example: _index_for(path, ['cloude_a'])
    """
    from src.core.db import connect

    with closing(connect(str(db_path), create=False)) as conn:
        return build_instance_index(conn, socket=SOCKET, names=list(names))


def test_the_seed_row_read_opens_no_connection_when_the_pass_took_one(
    seeded_db,
):
    """THE MEASUREMENT THAT FAILS ON THE PRE-FIX CODE.

    Before the fix every session's seed opened its own connection, so N
    sessions cost N opens inside one synchronous listing pass. With the
    pass's bulk index in hand the reader opens NONE, and the bound is
    expressed against N so any growth term at all is the defect
    returning.
    """
    db_path, keys = seeded_db
    index = _index_for(db_path, [name for name, _ in keys])
    assert index.complete is True, (
        "the index must report that its query RAN, or the seam is "
        "required to fall back and this measurement is meaningless"
    )

    manager = _CountingManager(db_path)
    rows = [
        read_instance_row(manager, name, epoch, index=index)
        for name, epoch in keys
    ]

    assert manager.opens == 0, (
        f"the seed read opened the datastore {manager.opens} times for "
        f"{INSTANCES} sessions despite the pass having already fetched "
        "every one of those rows in a single query. Opening a connection "
        "per session inside a synchronous listing pass is blocking "
        "SQLite on the event loop, which the user feels as lag in the "
        "TERMINAL rather than as a slow list."
    )
    assert all(row is not None for row in rows), (
        "a cheaper read that stops finding the rows is not the fix"
    )


def test_the_bulk_read_and_the_per_row_read_agree_field_for_field(seeded_db):
    """THE NEGATIVE CONTROL: reading once must not change the answer.

    A read that answered None for everything would open zero connections
    and pass the count above perfectly while blanking the status ladder
    for the whole pass. The two readers are run over the same rows and
    required to agree exactly - and the per-row reader is confirmed to
    have actually opened a connection, so this cannot pass by both sides
    doing nothing.
    """
    db_path, keys = seeded_db
    index = _index_for(db_path, [name for name, _ in keys])

    bulk_manager = _CountingManager(db_path)
    per_row_manager = _CountingManager(db_path)

    bulk: List[Optional[Dict[str, Any]]] = [
        read_instance_row(bulk_manager, name, epoch, index=index)
        for name, epoch in keys
    ]
    per_row: List[Optional[Dict[str, Any]]] = [
        read_instance_row(per_row_manager, name, epoch)
        for name, epoch in keys
    ]

    assert per_row_manager.opens == INSTANCES, (
        "the control did not exercise the per-row path it is controlling "
        f"for: it opened {per_row_manager.opens} connections for "
        f"{INSTANCES} rows"
    )
    assert bulk == per_row, (
        "reading the stored row once for the whole pass changed what the "
        "read says. The index may only change HOW MANY TIMES the row is "
        "fetched, never what the row means."
    )
    # And the rows are actually distinct, so agreement is not two readers
    # returning the same empty answer.
    assert len({row["activity_state"] for row in bulk}) == INSTANCES


def test_an_index_that_could_not_be_built_falls_back_and_never_answers_none(
    seeded_db,
):
    """A READING THAT DID NOT RUN IS NOT A READING OF NOTHING.

    ``build_instance_index`` degrades to an EMPTY index when the
    datastore cannot be opened. For a DECORATION that is harmless - a
    missing title renders as nothing, which is what the per-row read
    already produced. For the SEED it is not: None means "this session's
    instance could not be identified", so an index that could not be
    built would refuse the seed for every session in the pass and blank
    the status ladder. ``complete`` is what keeps those apart, and this
    is the test that the seam honours it.
    """
    db_path, keys = seeded_db
    name, epoch = keys[0]

    could_not_look = InstanceIndex()
    assert could_not_look.complete is False

    manager = _CountingManager(db_path)
    row = read_instance_row(manager, name, epoch, index=could_not_look)

    assert manager.opens == 1, (
        "an index that reports it could not be built must fall through "
        "to the per-row connection, which is exactly the behaviour every "
        "caller had before the index existed"
    )
    assert row is not None and row["activity_state"] == "state-0"


def test_a_complete_index_with_no_row_still_means_no_row(seeded_db):
    """The other half of ``complete``, and it must not be confused.

    A query that RAN and found nothing is a measurement: the instance has
    no stored row, which is the ordinary case for an external tmux
    session this app never created. That must answer None WITHOUT falling
    back, or the fallback would re-introduce a connection per row for
    exactly the sessions that have nothing to read.
    """
    db_path, _keys = seeded_db
    index = _index_for(db_path, ["cloude_seedcost_not_a_real_one"])
    assert index.complete is True

    manager = _CountingManager(db_path)
    row = read_instance_row(
        manager, "cloude_seedcost_not_a_real_one", 1_700_000_999, index=index
    )

    assert row is None
    assert manager.opens == 0, (
        "a complete index answering 'no row' is a measurement, not a "
        "failure to look, so it must not cost a fallback connection"
    )
