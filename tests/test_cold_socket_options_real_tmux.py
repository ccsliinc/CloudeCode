"""The socket's own options, measured after a launch on a COLD socket.

WHAT A COLD SOCKET IS, AND WHY IT IS THE ONLY INTERESTING CASE.
``set-option`` does NOT start a tmux server. Measured on tmux 3.6a: both
pre-spawn ``set-option`` calls in :meth:`TmuxBackend.start` exit 1 with
``error connecting to /private/tmp/tmux-<uid>/<socket> (No such file or
directory)`` when no server is running, batched or separate, and both
pass ``check=False`` so nothing says a word. After ``new-session`` the
socket reported tmux's stock ``history-limit 2000`` and
``remain-on-exit off``. That is the state every first session lands in
after a reboot, after a tmux server restart, or any time the socket's
last session closes and the server exits under ``exit-empty``.

WHY THIS FILE MEASURES THE SOCKET AND NOT THE ARGV. Asserting that the
commands were ISSUED proves nothing at all here: the pre-spawn code
issued exactly these two commands before this fix and they failed
silently every time. The only thing that separates a working launch from
the defect is what ``show-options`` answers afterwards, so that is what
is read. ``remain-on-exit`` is taken one step further and proved to
GOVERN - a pane whose process is killed must stay as a readable corpse -
because an option that reads ``on`` and does not hold the pane would be
the same silent failure wearing a correct value.

THE NEGATIVE CONTROL IS BUILT IN, NOT ASSUMED.
:func:`test_the_pre_spawn_options_alone_leave_a_cold_socket_on_the_defaults`
reproduces the PRE-FIX sequence inline against real tmux and asserts it
lands on 2000 / off. If a future change makes ``set-option`` start a
server, or moves the defect somewhere else, that test fails and says so,
rather than the whole file quietly passing for a reason nobody measured.

WHAT THIS FIX DOES NOT REACH, ALSO MEASURED AND ALSO PINNED.
A pane's scrollback depth is fixed into its grid when the pane is
created. A later ``set-option`` does not move it - not globally, not
session-scoped, and not across ``respawn-pane -k``. So the FIRST session
on a cold socket keeps 2000 rows for life and only its successors are
born at :data:`HISTORY_LIMIT`.
:func:`test_a_later_set_option_cannot_move_an_existing_panes_scrollback`
records that so the limitation is a measured fact in the suite rather
than a sentence in a comment.

SAFETY. Every tmux call in this file goes to a socket minted by
``tests.socket_guard.derive_test_socket``, which is unique per test and
provably owned by this pytest process. The production ``cloude`` socket
is unreachable from here.

Run with:
    venv/bin/python3 -m pytest tests/test_cold_socket_options_real_tmux.py -v
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time

import pytest

# Set before importing anything that constructs Settings, or the import
# fails on a missing default_working_dir and reads as a code failure that
# has nothing to do with what this file measures.
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_cold_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_cold_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.tmux_backend import HISTORY_LIMIT, TmuxBackend
from tests.socket_guard import derive_test_socket

pytestmark = pytest.mark.skipif(
    shutil.which("tmux") is None, reason="real tmux binary not available"
)

#: A command that stays alive long enough for the dead-on-arrival probe in
#: ``start()`` to see a healthy pane. A fast-exiting command would make
#: ``start()`` raise, and this file is measuring a SUCCESSFUL launch.
LONG_LIVED = "sleep 120"


def _tmux(socket: str, *args: str) -> subprocess.CompletedProcess:
    """Run one tmux command against a test socket.

    Args:
        socket: the test socket name, always one this process minted.
        *args: the tmux argv after the socket selector.

    Returns:
        subprocess.CompletedProcess: never raises on a non-zero exit, so
        the caller can read the return code as data.

    Example:
        >>> _tmux(sock, "show-options", "-gv", "history-limit").stdout
        '50000\\n'
    """
    return subprocess.run(
        ["tmux", "-L", socket, *args],
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
    )


def _option(socket: str, *args: str) -> str:
    """Read one tmux option value, stripped.

    Args:
        socket: the test socket name.
        *args: the ``show-options`` arguments after the socket selector.

    Returns:
        str: the value tmux printed, or "" when it could not answer.
        "" is a real third answer meaning "could not determine" and must
        not be read as a default.
    """
    result = _tmux(socket, "show-options", *args)
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


@pytest.fixture()
def cold_socket(request):
    """A socket with provably NO tmux server on it, killed on teardown.

    Args:
        request: pytest's request fixture, used only to label the socket.

    Yields:
        str: the socket name, asserted cold before the test body runs.

    The assertion is the point. A socket that already had a server would
    make every test in this file measure the warm path while reading like
    it measured the cold one, which is the exact shape of failure this
    file exists to catch.
    """
    socket = derive_test_socket(f"cold_{request.node.name[:16]}")
    _tmux(socket, "kill-server")
    probe = _tmux(socket, "list-sessions")
    assert probe.returncode != 0, (
        f"socket {socket!r} already has a tmux server on it, so this test "
        f"would measure the warm path: {probe.stdout.strip()!r}"
    )
    try:
        yield socket
    finally:
        _tmux(socket, "kill-server")


async def _launch(socket: str, work_dir, name: str) -> TmuxBackend:
    """Create one session through the real launch path.

    Args:
        socket: the cold test socket to launch on.
        work_dir: the pane's working directory.
        name: the tmux session name to take.

    Returns:
        TmuxBackend: the started backend, for the caller to stop.
    """
    backend = TmuxBackend(
        session_id=name,
        working_dir=work_dir,
        on_output=None,
        socket_name=socket,
        session_name=name,
    )
    await backend.start(command=LONG_LIVED)
    return backend


# --------------------------------------------------------------------- #
# the negative control: what the pre-spawn pair alone does to a cold socket
# --------------------------------------------------------------------- #


def test_the_pre_spawn_options_alone_leave_a_cold_socket_on_the_defaults(
    cold_socket, tmp_path
):
    """Reproduce the pre-fix sequence inline and measure that it fails.

    Without this, a fix that happened to be unnecessary would still make
    the positive tests below pass and nobody would learn anything. This
    asserts the DEFECT, so the file fails loudly if the ground it stands
    on ever moves.
    """
    socket = cold_socket

    # Exactly what start() issued before the spawn, and nothing else.
    pre = _tmux(
        socket,
        "set-option", "-g", "history-limit", str(HISTORY_LIMIT),
        ";",
        "set-option", "-wg", "remain-on-exit", "on",
    )
    assert pre.returncode != 0, (
        "set-option started a tmux server on this build of tmux, which is "
        "the premise of the whole defect. Re-measure before trusting any "
        "other test in this file."
    )
    assert "error connecting" in pre.stderr, pre.stderr

    created = _tmux(
        socket,
        "new-session", "-d", "-s", "cold_control",
        "-c", str(tmp_path), "-x", "100", "-y", "40", LONG_LIVED,
    )
    assert created.returncode == 0, created.stderr

    assert _option(socket, "-gv", "history-limit") == "2000"
    assert _option(socket, "-wgv", "remain-on-exit") == "off"


# --------------------------------------------------------------------- #
# the fix: a real launch leaves a cold socket carrying both options
# --------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_a_launch_on_a_cold_socket_leaves_the_socket_carrying_both_options(
    cold_socket, tmp_path
):
    """The measurement that fails without the post-spawn re-application.

    Read the socket, not the argv. The pre-spawn code issued these two
    commands before the fix as well, and they failed silently.
    """
    socket = cold_socket
    backend = await _launch(socket, tmp_path, "cloude_cold_first")
    try:
        assert _option(socket, "-gv", "history-limit") == str(HISTORY_LIMIT), (
            "the socket is still on tmux's stock scrollback depth after a "
            "launch, so every session created on it from here inherits 2000"
        )
        assert _option(socket, "-wgv", "remain-on-exit") == "on"
    finally:
        await backend.stop()


@pytest.mark.asyncio
async def test_remain_on_exit_actually_holds_a_dead_pane_on_a_cold_socket(
    cold_socket, tmp_path
):
    """An option that reads 'on' but does not hold the pane is no fix.

    ``show-options`` reporting the value is a claim about a table.
    ``#{pane_dead}`` after the process exits is the behaviour the setting
    exists for, which is what the dead-on-arrival probe depends on.
    """
    socket = cold_socket
    backend = await _launch(socket, tmp_path, "cloude_cold_corpse")
    try:
        killed = _tmux(socket, "respawn-pane", "-k", "-t", "cloude_cold_corpse",
                       "true")
        assert killed.returncode == 0, killed.stderr

        panes = ""
        for _ in range(40):
            probe = _tmux(socket, "list-panes", "-t", "cloude_cold_corpse",
                          "-F", "#{pane_dead}")
            if probe.returncode != 0:
                break
            panes = probe.stdout.strip()
            if panes == "1":
                break
            time.sleep(0.05)

        assert panes == "1", (
            "the pane did not survive its process exiting, so there is "
            "nothing for the dead-on-arrival probe to read: " + repr(panes)
        )
    finally:
        await backend.stop()


# --------------------------------------------------------------------- #
# the warm path, which must not have changed
# --------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_a_second_session_on_a_warm_socket_still_gets_both_options(
    cold_socket, tmp_path
):
    """The positive control for the common case.

    Every session after the first launches against a server that is
    already up, where the pre-spawn pair lands and the pane is BORN
    correct. That is the only path that can give a pane the full
    scrollback depth, so a fix that broke it would be a bad trade.
    """
    socket = cold_socket
    first = await _launch(socket, tmp_path, "cloude_warm_first")
    try:
        second = await _launch(socket, tmp_path, "cloude_warm_second")
        try:
            assert _option(socket, "-gv", "history-limit") == str(HISTORY_LIMIT)
            assert _option(socket, "-wgv", "remain-on-exit") == "on"

            born = _tmux(socket, "display-message", "-p",
                         "-t", "cloude_warm_second", "#{history_limit}")
            assert born.stdout.strip() == str(HISTORY_LIMIT), (
                "a pane born on a warm socket must carry the full depth in "
                "its own grid, which is the only way any pane ever gets it"
            )
        finally:
            await second.stop()
    finally:
        await first.stop()


# --------------------------------------------------------------------- #
# what the fix does NOT reach, pinned so it stays a measured fact
# --------------------------------------------------------------------- #


def test_a_later_set_option_cannot_move_an_existing_panes_scrollback(
    cold_socket, tmp_path
):
    """A pane keeps the depth it was born with, whatever the option says.

    This is why the first session on a cold socket keeps 2000 rows even
    after the post-spawn re-application, and why closing that would need
    a tmux server to exist BEFORE ``new-session``. Measured three ways:
    a global set, a session-scoped set, and a ``respawn-pane -k``.
    """
    socket = cold_socket
    created = _tmux(
        socket,
        "new-session", "-d", "-s", "cold_grid",
        "-c", str(tmp_path), "-x", "100", "-y", "40", LONG_LIVED,
    )
    assert created.returncode == 0, created.stderr

    def depth() -> str:
        probe = _tmux(socket, "display-message", "-p", "-t", "cold_grid",
                      "#{history_limit}")
        return probe.stdout.strip()

    assert depth() == "2000"

    _tmux(socket, "set-option", "-g", "history-limit", str(HISTORY_LIMIT))
    assert depth() == "2000"

    _tmux(socket, "set-option", "-t", "cold_grid", "history-limit",
          str(HISTORY_LIMIT))
    assert depth() == "2000"

    _tmux(socket, "respawn-pane", "-k", "-t", "cold_grid", LONG_LIVED)
    assert depth() == "2000"
