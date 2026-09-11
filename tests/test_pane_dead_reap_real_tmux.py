"""The dead-pane reaper, measured against a REAL tmux server.

WHY A DOUBLE CANNOT COVER THIS. ``tests/test_session_pane_death_reap.py``
pins the gate by handing it rows, which is the right way to reach the
eleven refusals a working box never produces. What a double CANNOT prove
is that those rows are the ones ``list_pane_status_all`` actually emits,
that ``remain-on-exit`` really does keep a dead session in
``list-sessions`` (the entire premise of this rung - if tmux dropped the
husk, the absence reaper would already have handled it and none of this
would be needed), or that ``#{pane_dead}`` really reads ``"1"`` for a pane
whose process exited. A fake agrees with whatever it was built to agree
with.

This project has already paid for that gap: a guard whose only exercised
caller set the flag it checked had never been observed to fire across
4874 green tests. So a rung that DELETES A SESSION FROM A USER-VISIBLE
LIST gets a real socket.

THE LIVE SESSION BESIDE IT IS THE CONTROL, AND IT IS THE HALF THAT
MATTERS. A reaper that reaped both would pass every assertion about the
husk perfectly.

SAFETY. Every tmux command in this file is aimed at a per-process
throwaway socket from ``tests.socket_guard.derive_test_socket``, and the
suite's subprocess guard refuses any tmux argv it cannot prove is aimed
there. Nothing here touches the ``cloude`` socket, which carries real
work.

Run with:
    ./venv/bin/python3 -m pytest tests/test_pane_dead_reap_real_tmux.py -v
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_pdr_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_pdr_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.db import connect, db_path_for, transaction
from src.core.db_migration import ensure_db_migrated
from src.core.db_models import (
    SESSION_LIFECYCLE_RUNNING,
    SESSION_LIFECYCLE_STOPPED,
)
from src.core.session_lifecycle import reconcile_from_listing
from src.core.session_pane_death import LIFECYCLE_SOURCE_PANE_DEAD
from src.core.session_status_map import status_map_from_listing
from src.core.tmux_backend import SESSION_PREFIX, TmuxBackend
from tests.lifecycle_helpers import add_row, row_by_uuid
# Imported as a MODULE, not as a bare name. tests/conftest.py derives
# the ``real_tmux`` marker from the socket-guard symbols a module
# holds, and ``socket_guard`` is one of them - so this spelling is
# what puts these tests in the contended group rather than in the
# fast loop, where a load-sensitive tmux test does not belong.
from tests import socket_guard

requires_tmux = pytest.mark.skipif(
    shutil.which("tmux") is None, reason="tmux not on PATH"
)

HUSK = f"{SESSION_PREFIX}pane_dead_husk"
LIVE = f"{SESSION_PREFIX}pane_dead_live"


@pytest.fixture
def tmux_socket():
    """A private tmux socket, torn down with every session on it.

    Inputs: none. Output: str - the socket name.
    """
    name = socket_guard.derive_test_socket("panedead")
    yield name
    tmux = shutil.which("tmux")
    if tmux:
        os.system(f"{tmux} -L {name} kill-server >/dev/null 2>&1")


def _backend(name: str, socket_name: str) -> TmuxBackend:
    """A probe backend pinned to the throwaway socket.

    Inputs: name (str) - tmux session name. socket_name (str).
    Output: TmuxBackend.
    """
    return TmuxBackend.for_external(
        session_name=name,
        working_dir=Path(tempfile.gettempdir()),
        on_output=None,
        socket_name=socket_name,
    )


def _pane_dead_for(probe: TmuxBackend, name: str):
    """Read one session's raw ``#{pane_dead}`` out of the bulk listing.

    Inputs: probe (TmuxBackend). name (str).
    Output: str | None - the raw field, or None when the name is absent.
    """
    for row in probe.list_pane_status_all().sessions:
        if row.get("name") == name:
            return row.get("pane_dead")
    return None


def _arrange_husk_and_live(probe: TmuxBackend) -> str:
    """Put one dead-pane husk and one live session on the socket.

    Description: the LIVE session is created FIRST on purpose, and not
      only as the control. ``set-option`` does NOT start a tmux server on
      a cold socket (CLAUDE.md records that measurement), so a ``-g
      remain-on-exit on`` issued before any session exists exits non-zero
      and silently does nothing - and the husk's pane would then vanish
      instead of surviving as a corpse, which is the arrangement this
      whole file needs.
    Inputs: probe (TmuxBackend) - pinned to the throwaway socket.
    Output: str - the husk's raw ``#{pane_dead}`` after a bounded poll.
    Example: _arrange_husk_and_live(probe)  # '1'
    """
    probe._run_tmux_sync(
        "new-session", "-d", "-s", LIVE, "sleep", "600", check=False
    )
    probe._run_tmux_sync("set-option", "-g", "remain-on-exit", "on", check=False)
    rc, _, err = probe._run_tmux_sync(
        "new-session", "-d", "-s", HUSK, "sh", "-c", "exit 0", check=False
    )
    assert rc == 0, err
    # The pane exits immediately; give tmux a moment to reap the process
    # and stamp the pane. Polled rather than slept blind, and bounded.
    raw = None
    for _ in range(50):
        raw = _pane_dead_for(probe, HUSK)
        if raw == "1":
            break
        time.sleep(0.1)
    return raw


@requires_tmux
def test_a_real_dead_pane_is_reaped_and_the_live_session_beside_it_is_not(
    tmux_socket, tmp_path
):
    """One pass over a real socket holding one husk and one live session."""
    probe = _backend(HUSK, tmux_socket)
    raw = _arrange_husk_and_live(probe)

    # ARRANGEMENT, ASSERTED. If either of these is false the test proves
    # nothing, so they are checked before the reaper is ever called.
    assert raw == "1", f"tmux did not report the husk's pane dead: {raw!r}"
    assert _pane_dead_for(probe, LIVE) == "0", "the control session is not alive"

    session_listing = probe.list_attachable_sessions(owned_names=set())
    assert session_listing.ok and session_listing.complete
    listed = {row["name"] for row in session_listing.sessions}
    assert HUSK in listed, (
        "remain-on-exit no longer keeps a dead session listed, which is "
        "the premise this whole rung exists for - the absence reaper "
        "would now handle it and this code would be dead"
    )
    assert LIVE in listed

    epochs = {row["name"]: row["created_at_epoch"] for row in session_listing.sessions}

    ensure_db_migrated(tmp_path, 4, "0.8.2")
    with closing(connect(db_path_for(tmp_path))) as conn:
        add_row(
            conn,
            uuid="u-husk",
            name=HUSK,
            epoch=epochs[HUSK],
            socket=tmux_socket,
        )
        add_row(
            conn,
            uuid="u-live",
            name=LIVE,
            epoch=epochs[LIVE],
            socket=tmux_socket,
        )
        pane_status = status_map_from_listing(
            probe.list_pane_status_all(), socket=tmux_socket
        )
        with transaction(conn):
            outcome = reconcile_from_listing(
                conn,
                listing=session_listing,
                socket=tmux_socket,
                pane_status=pane_status,
            )

        assert outcome.evaluated is True
        assert outcome.stopped_uuids == ("u-husk",), (
            "exactly one row may move; reaping the live session beside it "
            "would take a session the user is working in off their list"
        )
        assert outcome.pane_dead_stopped == 1

        husk = row_by_uuid(conn, "u-husk")
        assert husk["lifecycle"] == SESSION_LIFECYCLE_STOPPED
        assert husk["lifecycle_source"] == LIFECYCLE_SOURCE_PANE_DEAD
        assert husk["archived_at"] is None

        assert row_by_uuid(conn, "u-live")["lifecycle"] == SESSION_LIFECYCLE_RUNNING

    # THE TMUX HUSK IS NOT KILLED. remain-on-exit exists to keep the dead
    # pane's final screen readable, and reaping the app's row is a
    # different act from destroying that. A reaper that also killed the
    # session would pass every assertion above.
    still_listed = {
        row["name"] for row in probe.list_attachable_sessions(owned_names=set()).sessions
    }
    assert HUSK in still_listed, "the reaper killed the tmux session"
    assert LIVE in still_listed


@requires_tmux
def test_the_reap_adds_no_tmux_subprocess_of_its_own(tmux_socket, tmp_path):
    """THE COST CLAIM, COUNTED RATHER THAN ASSERTED IN PROSE.

    The rung reads a listing the caller already holds. Counting tmux
    invocations is the defect exactly - a wall clock on a loaded box would
    either flake or be too loose to prove anything.
    """
    probe = _backend(HUSK, tmux_socket)
    assert _arrange_husk_and_live(probe) == "1", "arrangement"

    session_listing = probe.list_attachable_sessions(owned_names=set())
    epoch = {r["name"]: r["created_at_epoch"] for r in session_listing.sessions}[HUSK]
    pane_status = status_map_from_listing(
        probe.list_pane_status_all(), socket=tmux_socket
    )

    ensure_db_migrated(tmp_path, 4, "0.8.2")
    with closing(connect(db_path_for(tmp_path))) as conn:
        add_row(conn, uuid="u-husk", name=HUSK, epoch=epoch, socket=tmux_socket)

        calls = []
        real_run = TmuxBackend._run_tmux_sync

        def counting(self, *args, **kwargs):
            """Record the argv, then delegate to the real runner."""
            calls.append(args)
            return real_run(self, *args, **kwargs)

        TmuxBackend._run_tmux_sync = counting
        try:
            with transaction(conn):
                outcome = reconcile_from_listing(
                    conn,
                    listing=session_listing,
                    socket=tmux_socket,
                    pane_status=pane_status,
                )
        finally:
            TmuxBackend._run_tmux_sync = real_run

    assert outcome.pane_dead_stopped == 1, "the rung did not fire, so this proves nothing"
    assert calls == [], f"the reap spawned tmux: {calls}"
