"""The recreate gate, measured against a REAL tmux server.

WHY A DOUBLE CANNOT COVER THIS. ``tests/test_session_recreate.py`` pins
the classifier by handing it the three facts a listing reports, which is
the right way to reach the branches a working box never produces. What it
CANNOT prove is that those three facts are the ones ``discover_existing``
actually hands back - the shape of ``TmuxListing``, the namespace filter,
and whether a killed session really does disappear from the listing this
gate reads. A fake agrees with whatever it was built to agree with.

This project has already paid for that exact gap once: a guard whose only
exercised caller set the flag it checked had never been observed to fire
across 4874 green tests (see CLAUDE.md, the boot re-adopt). So the gate on
an irreversible action gets a real socket.

ONE SESSION, THREE READINGS: present while it runs, gone once it is
killed, and a name that never existed reading gone as well. The middle one
is the transition the feature exists for; the third is the negative
control that stops "gone" from meaning "I looked in the wrong place".
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_rcg_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_rcg_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.session_recreate_presence import (
    TMUX_GONE,
    TMUX_PRESENT,
    tmux_presence,
)
from src.core.tmux_backend import SESSION_PREFIX, TmuxBackend
from tests.socket_guard import derive_test_socket

requires_tmux = pytest.mark.skipif(
    shutil.which("tmux") is None, reason="tmux not on PATH"
)


@pytest.fixture
def tmux_socket():
    """A private tmux socket, torn down with every session on it.

    Inputs: none. Output: str - the socket name.
    """
    name = derive_test_socket("recreate")
    yield name
    tmux = shutil.which("tmux")
    if tmux:
        os.system(f"{tmux} -L {name} kill-server >/dev/null 2>&1")


def _read(name: str, socket_name: str):
    """Measure one name against the real socket, exactly as the route does.

    Description: the SAME two steps ``recreate_routes._measure_presence``
      performs - one ``discover_existing()`` read, then the pure gate -
      spelled here rather than imported so this test exercises the tmux
      half without pulling the FastAPI app in behind it.
    Inputs: name (str) - literal tmux session name. socket_name (str).
    Output: TmuxPresence.
    """
    probe = TmuxBackend.for_external(
        session_name=name,
        working_dir=Path(tempfile.gettempdir()),
        on_output=None,
        socket_name=socket_name,
    )
    listing = probe.discover_existing()
    return tmux_presence(
        name,
        listing_ok=bool(listing.ok),
        listing_complete=bool(listing.complete),
        names=list(listing.sessions or []),
        namespace_prefix=SESSION_PREFIX,
    )


@requires_tmux
def test_a_live_session_reads_present_and_a_killed_one_reads_gone(tmux_socket):
    """The transition the whole feature is gated on, on a real server."""
    name = f"{SESSION_PREFIX}recreate_probe"
    backend = TmuxBackend.for_external(
        session_name=name,
        working_dir=Path(tempfile.gettempdir()),
        on_output=None,
        socket_name=tmux_socket,
    )
    rc, _, err = backend._run_tmux_sync(
        "new-session", "-d", "-s", name, "sh", check=False
    )
    assert rc == 0, err

    live = _read(name, tmux_socket)
    assert live.outcome == TMUX_PRESENT, live.detail
    assert live.gone is False, (
        "a running session read as gone would be recreated over, and the "
        "pane the user is talking to would be orphaned"
    )

    rc, _, err = backend._run_tmux_sync(
        "kill-session", "-t", name, check=False
    )
    assert rc == 0, err

    dead = _read(name, tmux_socket)
    assert dead.outcome == TMUX_GONE, dead.detail
    assert dead.gone is True


@requires_tmux
def test_a_name_that_never_existed_reads_gone_against_a_live_server(
    tmux_socket,
):
    """NEGATIVE CONTROL for the reading itself.

    A gate that answered ``gone`` because it was talking to no server at
    all would pass the test above and be worthless. Here a real server is
    running with a real session on it, and only the name being asked
    about is absent.
    """
    name = f"{SESSION_PREFIX}recreate_neighbour"
    backend = TmuxBackend.for_external(
        session_name=name,
        working_dir=Path(tempfile.gettempdir()),
        on_output=None,
        socket_name=tmux_socket,
    )
    rc, _, err = backend._run_tmux_sync(
        "new-session", "-d", "-s", name, "sh", check=False
    )
    assert rc == 0, err

    assert _read(name, tmux_socket).outcome == TMUX_PRESENT
    assert _read(
        f"{SESSION_PREFIX}never_existed", tmux_socket
    ).outcome == TMUX_GONE


@requires_tmux
def test_a_name_outside_the_namespace_is_never_measured_gone(tmux_socket):
    """Reading the FILTER is not reading the socket.

    ``discover_existing`` only returns ``cloude_``-prefixed names, so an
    adopted external session is absent from that listing whether or not
    it is running. Here one IS running and the gate must still refuse to
    call it gone.
    """
    name = "someone_elses_tmux"
    backend = TmuxBackend.for_external(
        session_name=name,
        working_dir=Path(tempfile.gettempdir()),
        on_output=None,
        socket_name=tmux_socket,
    )
    rc, _, err = backend._run_tmux_sync(
        "new-session", "-d", "-s", name, "sh", check=False
    )
    assert rc == 0, err

    verdict = _read(name, tmux_socket)
    assert verdict.gone is False
    assert "namespace" in verdict.detail
