"""The FIRST pane on a cold socket is born at the full scrollback depth.

WHAT SEPARATES THIS FILE FROM ``test_cold_socket_options_real_tmux.py``.
That one measures the SOCKET's option tables, which #87 fixed. This one
measures THE PANE'S OWN ``#{history_limit}``, which #87 could not reach
and which is the number that decides how much history the user actually
keeps. The distinction is the entire point: a pane's depth is fixed into
its grid by ``window_pane_create``, so the option table can read 50000
while the pane holding it reads 2000, and reading the option table alone
would report a fix that had not happened.

THE MECHANISM, AND WHY IT IS THE ONLY ONE. ``set-option`` does not start
a tmux server, so on a cold socket the pre-spawn pair cannot run; and no
``set-option`` after the spawn moves an existing pane's grid. ``tmux -f
<file>`` is read when the SERVER STARTS, which on a cold socket happens
inside the ``new-session`` invocation itself and strictly before the
session is created. That is the only window, and it costs no extra tmux
process.

WHY THE PROCESS COUNT IS ASSERTED HERE. ``-f`` was chosen over warming
the server with ``start-server`` plus ``exit-empty off`` specifically
because it spends nothing. A change that quietly added a process would
have thrown away the whole reason for the approach, so the count is
measured by COUNTING rather than by timing - a wall clock on a loaded box
would either flake or be too loose to prove anything.

WHY EVERY FAILURE PATH IS EXERCISED. Measured on tmux 3.6a, a malformed
``-f`` file makes tmux DISCARD THE WHOLE CONFIG SILENTLY: ``rc=0``, the
session is created, a valid line placed before the bad one does not apply
either, and nothing is printed. So a subtly wrong file costs the session
every option and announces nothing. The only way to catch that is to
measure the pane afterwards, which is what this file does, and to prove
that an unwritable location still yields a working session.

SAFETY. Every tmux call goes to a socket minted by
``tests.socket_guard.derive_test_socket``, unique per test and provably
owned by this pytest process. The production ``cloude`` socket is
unreachable from here.

Run with:
    venv/bin/python3 -m pytest tests/test_cold_socket_born_at_depth_real_tmux.py -v
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile

import pytest

# Set before importing anything that constructs Settings, or the import
# fails on a missing default_working_dir and reads as a code failure that
# has nothing to do with what this file measures.
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_born_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_born_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core import tmux_backend as tmux_backend_module
from src.core.tmux_backend import HISTORY_LIMIT, TmuxBackend
from src.core.tmux_server_config import (
    SERVER_CONFIG_FILENAME,
    render_config,
    render_config_line,
    write_server_config,
)
from tests.socket_guard import derive_test_socket

pytestmark = pytest.mark.skipif(
    shutil.which("tmux") is None, reason="real tmux binary not available"
)

#: Long enough that the dead-on-arrival probe in ``start()`` sees a
#: healthy pane. A fast-exiting command makes ``start()`` raise, and this
#: file measures a SUCCESSFUL launch.
LONG_LIVED = "sleep 120"

#: tmux's stock scrollback depth, which is what a pane born without our
#: config carries. Named rather than repeated, so the two places that
#: assert the defect say the same thing.
STOCK_HISTORY_LIMIT = "2000"

#: tmux processes ONE COLD launch spends, measured at base and at head and
#: identical at both. Two more than the six a WARM launch spends, because
#: the pre-spawn batch cannot reach a server that is not running and
#: ``run_optional_batch`` therefore re-runs its two commands individually.
#: ``-f`` adds none: it is two argv elements on the spawn.
COLD_LAUNCH_TMUX_PROCESSES = 8


def _tmux(socket: str, *args: str) -> subprocess.CompletedProcess:
    """Run one tmux command against a test socket.

    Args:
        socket: the test socket name, always one this process minted.
        *args: the tmux argv after the socket selector.

    Returns:
        subprocess.CompletedProcess: never raises on a non-zero exit.
    """
    return subprocess.run(
        ["tmux", "-L", socket, *args],
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
    )


def _pane_depth(socket: str, name: str) -> str:
    """Read a pane's OWN scrollback depth, not the option table.

    Args:
        socket: the test socket name.
        name: the tmux session whose pane to measure.

    Returns:
        str: the value of ``#{history_limit}`` for that pane, or "" when
        tmux could not answer. "" is "could not determine" and must not
        be read as a default.
    """
    probe = _tmux(socket, "display-message", "-p", "-t", name, "#{history_limit}")
    if probe.returncode != 0:
        return ""
    return probe.stdout.strip()


@pytest.fixture()
def cold_socket(request):
    """A socket with provably NO tmux server on it, killed on teardown.

    Args:
        request: pytest's request fixture, used only to label the socket.

    Yields:
        str: the socket name, asserted cold before the test body runs.

    The assertion is load-bearing. A socket that already had a server
    would make this file measure the warm path while reading like it
    measured the cold one, which is the exact failure it exists to catch.
    """
    socket = derive_test_socket(f"born_{request.node.name[:16]}")
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
        socket: the test socket to launch on.
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
# the config body: rendered exactly, or refused as a unit
# --------------------------------------------------------------------- #


def test_a_command_renders_as_the_line_you_would_type():
    assert render_config_line(
        ("set-option", "-g", "history-limit", "50000")
    ) == "set-option -g history-limit 50000"


def test_a_token_that_would_change_the_parse_is_refused():
    """tmux discards a whole config it cannot parse, silently.

    So a hopeful quote is worse than a refusal: the file would look
    written and cost the session every option in it.
    """
    assert render_config_line(("set-option", "-g", "a b")) is None
    assert render_config_line(("set-option", "-g", 'a"b')) is None
    assert render_config_line(("set-option", "-g", "a#b")) is None
    assert render_config_line(("set-option", "-g", "a;b")) is None
    assert render_config_line(()) is None


def test_one_unrenderable_command_refuses_the_whole_file():
    """A partial config is not a partial success; tmux drops all of it."""
    assert render_config([("set-option", "-g", "mouse", "on")]) == (
        "set-option -g mouse on\n"
    )
    assert render_config(
        [("set-option", "-g", "mouse", "on"), ("set-option", "-g", "a b")]
    ) is None
    assert render_config([]) is None


def test_an_unwritable_directory_answers_none_rather_than_raising(tmp_path):
    """The launch must proceed without the config, never fail because of it."""
    blocked = tmp_path / "blocked"
    blocked.mkdir()
    blocked.chmod(0o500)
    try:
        assert write_server_config(
            blocked, [("set-option", "-g", "mouse", "on")]
        ) is None
    finally:
        blocked.chmod(0o700)


def test_the_write_is_atomic_and_leaves_no_temp_file_behind(tmp_path):
    written = write_server_config(
        tmp_path,
        [("set-option", "-g", "history-limit", str(HISTORY_LIMIT))],
    )
    assert written == tmp_path / SERVER_CONFIG_FILENAME
    assert written.read_text(encoding="utf-8") == (
        f"set-option -g history-limit {HISTORY_LIMIT}\n"
    )
    assert [p.name for p in tmp_path.iterdir()] == [SERVER_CONFIG_FILENAME]


# --------------------------------------------------------------------- #
# REAL tmux: the pane's own depth, cold and warm
# --------------------------------------------------------------------- #


def test_a_cold_socket_without_the_config_is_born_on_the_stock_depth(
    cold_socket, tmp_path
):
    """The negative control, reproduced inline against real tmux.

    Without this, a fix that was unnecessary would still make the test
    below pass and nobody would learn anything.
    """
    socket = cold_socket
    created = _tmux(
        socket,
        "new-session", "-d", "-s", "born_control",
        "-c", str(tmp_path), "-x", "100", "-y", "40", LONG_LIVED,
    )
    assert created.returncode == 0, created.stderr
    assert _pane_depth(socket, "born_control") == STOCK_HISTORY_LIMIT


@pytest.mark.asyncio
async def test_the_first_pane_on_a_cold_socket_is_born_at_the_full_depth(
    cold_socket, tmp_path
):
    """The measurement that fails without the -f config.

    Reads the PANE, not the option table. #87 already made the option
    table read correctly here while this number stayed at 2000.
    """
    socket = cold_socket
    backend = await _launch(socket, tmp_path, "cloude_born_first")
    try:
        assert _pane_depth(socket, "cloude_born_first") == str(HISTORY_LIMIT), (
            "the first pane on a cold socket is still carrying tmux's stock "
            "scrollback depth, so this session holds 48000 fewer lines of "
            "history than every other session on the box"
        )
    finally:
        await backend.stop()


@pytest.mark.asyncio
async def test_a_second_session_on_a_warm_socket_is_still_born_at_the_full_depth(
    cold_socket, tmp_path
):
    """The warm path, which is every session after the first.

    tmux ignores -f once a server is up, so this one is carried by the
    pre-spawn set-option pair exactly as it always was. A fix that broke
    it would be a bad trade.
    """
    socket = cold_socket
    first = await _launch(socket, tmp_path, "cloude_born_warm_a")
    try:
        second = await _launch(socket, tmp_path, "cloude_born_warm_b")
        try:
            assert _pane_depth(socket, "cloude_born_warm_b") == str(HISTORY_LIMIT)
        finally:
            await second.stop()
    finally:
        await first.stop()


@pytest.mark.asyncio
async def test_a_config_that_cannot_be_written_still_launches_a_session(
    cold_socket, tmp_path, monkeypatch
):
    """Losing depth is survivable; refusing to open a session is not.

    Forces the write to fail the way a read-only state directory would,
    and asserts the launch still succeeds and simply falls back to the
    pre-fix depth.
    """
    socket = cold_socket
    monkeypatch.setattr(
        tmux_backend_module, "write_server_config", lambda *_a, **_k: None
    )
    backend = await _launch(socket, tmp_path, "cloude_born_nofile")
    try:
        assert _tmux(socket, "has-session", "-t", "cloude_born_nofile").returncode == 0
        assert _pane_depth(socket, "cloude_born_nofile") == STOCK_HISTORY_LIMIT
    finally:
        await backend.stop()


# --------------------------------------------------------------------- #
# the cost: two argv elements, zero processes
# --------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_the_launch_spends_no_extra_tmux_process(cold_socket, tmp_path):
    """-f was chosen over warming the server BECAUSE it spends nothing.

    Counted, not timed: the count is the claim exactly, and a wall clock
    on a loaded box would either flake or be too loose to prove anything.

    THE NUMBER IS MEASURED, NOT GUESSED. A COLD launch spends EIGHT tmux
    processes at base and eight at head; a warm one spends six at both.
    Cold costs two more than the six CLAUDE.md quotes because the
    pre-spawn batch cannot connect to a server that is not running, so
    ``run_optional_batch`` re-runs its two commands individually - one
    batch plus two singles instead of one batch. That is #87's existing
    fallback and not something ``-f`` added.

    The ceiling is pinned rather than the exact number, so an unrelated
    refactor that removes a call does not fail this file; what it catches
    is the count GROWING, which is the defect.
    """
    socket = cold_socket
    spawned: list = []
    original = asyncio.create_subprocess_exec

    async def counting(*args, **kwargs):
        spawned.append(args)
        return await original(*args, **kwargs)

    asyncio.create_subprocess_exec = counting
    try:
        backend = await _launch(socket, tmp_path, "cloude_born_count")
    finally:
        asyncio.create_subprocess_exec = original

    try:
        tmux_calls = [a for a in spawned if a and str(a[0]).endswith("tmux")]
        assert len(tmux_calls) <= COLD_LAUNCH_TMUX_PROCESSES, (
            "the launch grew a tmux process. -f is supposed to be two argv "
            f"elements on a call already being made: {len(tmux_calls)} calls "
            f"against a measured ceiling of {COLD_LAUNCH_TMUX_PROCESSES}"
        )
        with_config = [a for a in tmux_calls if "-f" in a]
        assert len(with_config) == 1, (
            "-f must ride on exactly one invocation, the spawn: "
            f"{len(with_config)}"
        )
        spawn = with_config[0]
        assert spawn[spawn.index("-f") - 1] == socket, (
            "-f must sit among the server options, after -L <socket> and "
            "before the command word, which is where tmux requires it"
        )
        assert "new-session" in spawn
        assert spawn.index("-f") < spawn.index("new-session")
    finally:
        await backend.stop()
