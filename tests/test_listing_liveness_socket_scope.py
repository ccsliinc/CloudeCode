"""A bulk listing may only vouch for the socket it was taken from.

WHY THIS FILE EXISTS. ``session_status_map.listing_proves_alive`` lets one
``tmux list-panes -a`` stand in for the per-session ``tmux has-session``
that ``_session_info_for`` used to run, which is the whole saving of the
listing-cost round. The call it replaces probed THE BACKEND'S OWN socket;
the listing is taken from the PROBE'S socket. As shipped, the function
compared neither, so a session NAME found on the probe's socket vouched
for a session held by a backend pinned somewhere else.

A tmux session name is not unique across sockets. This app mints names
from project slugs (``cloude_<slug>``), the same project can be opened
against more than one socket over a machine's life, and a user's personal
tmux server can hold a ``cloude_Foo`` of its own. The failure mode is the
one this codebase keeps paying for: a DEAD session painting a confident
green ``Connected`` dot, because something that was not asked about it
answered for it.

WHAT IS MEASURED HERE, against REAL tmux on two throwaway sockets:

  * ``cloude_xsock_probe`` exists and is ALIVE on socket A.
  * a session of the SAME NAME on socket B is killed, so a backend pinned
    to B is measurably NOT alive.
  * the listing is taken from A and carries A's socket.

The PRE-FIX RULE is reproduced inline as ``_pre_fix_proves_alive`` and
asserted to answer True for that arrangement. That is what makes this a
regression pin rather than a signature check: it shows the defect is
reachable with real tmux state, and it fails loudly if anyone restores
the old rule. The shipped function must answer False, and the caller then
pays exactly the probe it was always paying.

SAFETY. Both sockets come from ``tests.socket_guard.derive_test_socket``,
so they are provably owned by this pytest process and the installed
subprocess guard rejects any tmux argv aimed anywhere else. The
production socket is unreachable from this file.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_xsock_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_xsock_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.session_status_map import StatusMap, listing_proves_alive
from src.core.tmux_backend import TmuxBackend
from tests.socket_guard import derive_test_socket

requires_tmux = pytest.mark.skipif(
    shutil.which("tmux") is None, reason="tmux not on PATH"
)

#: The one session name used on BOTH sockets. Shaped like a real one,
#: because the defect is specifically that this app's names are derived
#: from project slugs and are therefore collidable by construction.
SHARED_NAME = "cloude_xsock_probe"


def _tmux(socket: str, *args: str) -> subprocess.CompletedProcess:
    """Run one tmux command against a named throwaway socket.

    Inputs: socket (str) - a socket minted by ``derive_test_socket``.
        args (str) - the tmux argv after ``-L <socket>``.
    Output: subprocess.CompletedProcess, text captured, never checked.
    Example: _tmux(sock, 'kill-server')
    """
    return subprocess.run(
        ["tmux", "-L", socket, *args],
        capture_output=True,
        text=True,
        check=False,
    )


def _pre_fix_proves_alive(
    status_map: Optional[Dict[str, Any]], tmux_name: Optional[str]
) -> bool:
    """The rule as it shipped, before the socket was compared.

    Description: reproduced here on purpose. Without it this file would
        only be asserting that a keyword argument exists, which any
        signature change would satisfy; with it, the test states the
        DEFECT as a fact about real tmux state and fails if the old rule
        ever comes back. It is deliberately not imported from anywhere -
        nothing in ``src`` should be able to reach it.
    Inputs: status_map (mapping | None). tmux_name (str | None).
    Output: bool - True when a COMPLETE listing names the session,
        whatever socket that listing came from.
    Example: _pre_fix_proves_alive(StatusMap({'a': {}}, complete=True), 'a')
    """
    if not tmux_name:
        return False
    if status_map is None:
        return False
    if not getattr(status_map, "complete", False):
        return False
    return tmux_name in status_map


@pytest.fixture
def two_sockets():
    """Two live tmux servers owned by this pytest process.

    Description: socket A keeps ``SHARED_NAME`` alive for the whole test;
        socket B is given a session of the same name which is then
        killed, so a backend pinned to B is MEASURABLY dead rather than
        merely absent. Both servers are killed on teardown whatever the
        test did.
    Inputs: none.
    Output: tuple[str, str] - (socket_a, socket_b).
    Example: sock_a, sock_b = two_sockets
    """
    sock_a = derive_test_socket("xsock_a")
    sock_b = derive_test_socket("xsock_b")
    try:
        yield sock_a, sock_b
    finally:
        _tmux(sock_a, "kill-server")
        _tmux(sock_b, "kill-server")


@requires_tmux
def test_a_listing_from_another_socket_cannot_vouch_for_a_dead_session(
    two_sockets,
):
    """The cross-socket positive is refused, and the old rule accepted it."""
    sock_a, sock_b = two_sockets

    # Socket A: the name is ALIVE here, and this is the listing's socket.
    assert _tmux(sock_a, "new-session", "-d", "-s", SHARED_NAME).returncode == 0
    # Socket B: same name, then killed, so B's backend is measurably dead.
    assert _tmux(sock_b, "new-session", "-d", "-s", SHARED_NAME).returncode == 0
    assert _tmux(sock_b, "kill-session", "-t", SHARED_NAME).returncode == 0

    # ``for_external`` binds a backend to a LITERAL tmux name rather
    # than slugifying a session id, which is what lets both backends here
    # carry the one colliding name and differ only in their socket.
    backend_b = TmuxBackend.for_external(
        session_name=SHARED_NAME,
        working_dir=Path(tempfile.gettempdir()),
        socket_name=sock_b,
    )

    # GROUND TRUTH, measured rather than assumed: the backend's own probe
    # says this session is gone. Everything below is about whether a
    # listing from a DIFFERENT socket is allowed to contradict it.
    assert backend_b.is_alive() is False

    listing_from_a = StatusMap(
        {SHARED_NAME: {"status": "running"}}, complete=True, socket=sock_a
    )

    # THE DEFECT, reproduced. The shipped rule would have called a dead
    # session alive on the strength of a name on someone else's socket.
    assert _pre_fix_proves_alive(listing_from_a, SHARED_NAME) is True

    # THE FIX. Asked about socket B, the listing from A proves nothing,
    # so the caller falls through to the probe it was always paying.
    assert (
        listing_proves_alive(
            listing_from_a, SHARED_NAME, backend_socket=backend_b.socket_name
        )
        is False
    )


@requires_tmux
def test_the_saving_survives_for_a_backend_on_the_listings_own_socket(
    two_sockets,
):
    """THE POSITIVE CONTROL: a same-socket backend still skips its probe.

    A fix that refused everything would pass the test above perfectly and
    quietly restore the per-row ``has-session`` this round removed. This
    is the half that proves it did not.
    """
    sock_a, _sock_b = two_sockets
    assert _tmux(sock_a, "new-session", "-d", "-s", SHARED_NAME).returncode == 0

    backend_a = TmuxBackend.for_external(
        session_name=SHARED_NAME,
        working_dir=Path(tempfile.gettempdir()),
        socket_name=sock_a,
    )
    assert backend_a.is_alive() is True

    listing_from_a = StatusMap(
        {SHARED_NAME: {"status": "running"}}, complete=True, socket=sock_a
    )
    assert (
        listing_proves_alive(
            listing_from_a, SHARED_NAME, backend_socket=backend_a.socket_name
        )
        is True
    )


def test_an_unstated_socket_on_either_side_refuses():
    """Not stated is refused, never assumed to match.

    Description: the same discipline ``complete`` already carries. A map
        built by an older caller states no socket; a caller that passes
        none has not said which socket it is asking about. Either way the
        answer is False, which costs the probe and nothing else. No tmux
        needed - this is the pure rule.
    """
    stated = StatusMap({SHARED_NAME: {}}, complete=True, socket="cloude")
    unstated = StatusMap({SHARED_NAME: {}}, complete=True)

    assert listing_proves_alive(stated, SHARED_NAME, backend_socket=None) is False
    assert (
        listing_proves_alive(unstated, SHARED_NAME, backend_socket="cloude")
        is False
    )
    assert listing_proves_alive(stated, SHARED_NAME, backend_socket="cloude") is True

    # A plain dict states neither, which is how every pre-StatusMap test
    # double keeps the behaviour it had.
    assert (
        listing_proves_alive({SHARED_NAME: {}}, SHARED_NAME, backend_socket="cloude")
        is False
    )
