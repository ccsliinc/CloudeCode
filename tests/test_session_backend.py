"""Tests for src.core.session_backend + TmuxBackend + PTYBackend.

Run with:
    python3 -m pytest tests/test_session_backend.py -v
"""

from __future__ import annotations

import asyncio
import os
import secrets
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from unittest import mock

import pytest


# ---- minimal env bootstrap so `src.config` import succeeds --------------
# The pydantic Settings loader raises + sys.exit(1) if DEFAULT_WORKING_DIR
# or LOG_DIRECTORY are missing. Inject safe defaults before any imports.

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_tests_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_tests_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.session_backend import SessionBackend, build_backend
from src.core.tmux_backend import (
    INITIAL_COLS,
    INITIAL_ROWS,
    TmuxBackend,
    _has_control_chars,
    _slugify,
)
from src.utils.pty_session import PTYBackend


TMUX_AVAILABLE = shutil.which("tmux") is not None
requires_tmux = pytest.mark.skipif(not TMUX_AVAILABLE, reason="tmux not on PATH")


# ---- slug sanitizer ------------------------------------------------------


def test_slugify_replaces_dots():
    assert "." not in _slugify("my.project.name")
    assert _slugify("my.project") == "my_project"


def test_slugify_handles_mixed_invalid_chars():
    assert _slugify("hello world:foo/bar.baz") == "hello_world_foo_bar_baz"


def test_slugify_preserves_alphanumeric_and_dash_underscore():
    assert _slugify("My-Session_42") == "My-Session_42"


def test_slugify_empty_input_returns_default():
    assert _slugify("") == "default"
    assert _slugify("...") == "default"


# ---- control-char classifier --------------------------------------------


def test_has_control_chars_flags_etx():
    assert _has_control_chars(b"\x03hello")


def test_has_control_chars_flags_escape():
    assert _has_control_chars(b"\x1b[A")


def test_has_control_chars_ignores_whitespace():
    assert not _has_control_chars(b"hello\tworld\n")
    assert not _has_control_chars(b"line1\r\nline2")


def test_has_control_chars_flags_del():
    assert _has_control_chars(b"foo\x7fbar")


# ---- PTYBackend conforms to the ABC --------------------------------------


def test_pty_backend_is_session_backend():
    backend = PTYBackend(
        session_id="test",
        working_dir=Path.home(),
        on_output=None,
    )
    assert isinstance(backend, SessionBackend)


def test_pty_backend_discover_existing_is_empty():
    backend = PTYBackend("test", Path.home(), None)
    assert backend.discover_existing() == []


def test_pty_backend_capture_scrollback_is_empty():
    backend = PTYBackend("test", Path.home(), None)
    assert backend.capture_scrollback() == b""


def test_pty_backend_required_methods_are_present():
    """Every abstract method in SessionBackend must be concretely implemented."""
    backend = PTYBackend("test", Path.home(), None)
    for name in (
        "start",
        "stop",
        "write",
        "resize",
        "is_alive",
        "read_async",
        "discover_existing",
        "capture_scrollback",
    ):
        assert callable(getattr(backend, name)), f"missing {name}"


# ---- build_backend factory ----------------------------------------------


def test_build_backend_falls_back_to_pty_when_tmux_missing():
    with mock.patch("src.core.session_backend.shutil.which", return_value=None):
        backend = build_backend(
            settings_obj=None,
            session_id="fallback-test",
            working_dir=Path.home(),
            on_output=None,
        )
        assert isinstance(backend, PTYBackend), (
            f"expected PTYBackend fallback, got {type(backend).__name__}"
        )


def test_build_backend_force_pty_even_when_tmux_present():
    """A Settings-like object forcing 'pty' must skip tmux."""
    class StubSettings:
        def load_auth_config(self):
            class AC:
                class session:
                    backend = "pty"
                    tmux_socket_name = "cloude"
                    scrollback_lines = 3000
            return AC()

    backend = build_backend(
        settings_obj=StubSettings(),
        session_id="forced-pty",
        working_dir=Path.home(),
        on_output=None,
    )
    assert isinstance(backend, PTYBackend)


@requires_tmux
def test_build_backend_auto_picks_tmux_when_available():
    backend = build_backend(
        settings_obj=None,
        session_id="auto-pick",
        working_dir=Path.home(),
        on_output=None,
    )
    assert isinstance(backend, TmuxBackend)


# ---- TmuxBackend integration (requires tmux) ----------------------------


# Use a unique socket per test run so CI parallelism + local dev don't clash.
_TEST_SOCKET = f"cloude_test_{uuid.uuid4().hex[:8]}"


@pytest.fixture
def tmux_socket_cleanup():
    """Kill the test tmux server after each test, regardless of outcome."""
    yield _TEST_SOCKET
    try:
        import subprocess
        subprocess.run(
            ["tmux", "-L", _TEST_SOCKET, "kill-server"],
            capture_output=True,
            check=False,
        )
    except Exception:
        pass


@requires_tmux
def test_tmux_backend_discover_existing_finds_created_session(tmux_socket_cleanup):
    """After start(), discover_existing() must include this backend's session name."""
    backend = TmuxBackend(
        session_id=f"discovery-test-{uuid.uuid4().hex[:6]}",
        working_dir=Path.home(),
        on_output=None,
        socket_name=tmux_socket_cleanup,
    )
    try:
        asyncio.run(backend.start())
        names = backend.discover_existing()
        assert backend.tmux_session in names, (
            f"expected {backend.tmux_session} in {names}"
        )
        assert backend.is_alive()
    finally:
        asyncio.run(backend.stop())


@requires_tmux
def test_tmux_backend_write_large_paste_delivers_content_to_pane(tmux_socket_cleanup):
    """Large payloads (>PASTE_THRESHOLD_BYTES) route through the paste path
    (load-buffer + paste-buffer -d -p) and the content reaches the pane.

    tmux's own emulator consumes the bracketed-paste markers (\\x1b[200~ /
    \\x1b[201~) before they appear in `capture-pane` output, so we can't
    assert on the markers here — that contract is locked by the mocked argv
    test ``test_tmux_backend_write_large_payload_uses_load_and_paste_buffer``.
    What we CAN verify end-to-end is that a large payload actually reaches
    the pane (the paste path is wired up correctly and doesn't swallow the
    bytes).
    """
    backend = TmuxBackend(
        session_id=f"bigpaste-{uuid.uuid4().hex[:6]}",
        working_dir=Path.home(),
        on_output=None,
        socket_name=tmux_socket_cleanup,
    )

    async def _inner():
        # Use /bin/cat as the pane's first process — no prompt, echoes stdin.
        await backend.start(command="/bin/cat")
        # Give cat time to start up.
        await asyncio.sleep(0.3)

        payload = b"abc" * 700  # 2100 bytes, > PASTE_THRESHOLD_BYTES → paste path
        await backend.write(payload)

        # Let the paste buffer flush through the pane.
        await asyncio.sleep(0.8)

        cap = backend.capture_scrollback(lines=500)
        text = cap.decode("utf-8", errors="replace")

        # `cat` echoes whatever lands on stdin, so we should see 'abc' in
        # the pane. If paste-buffer had failed, the pane would be empty.
        assert "abc" in text, (
            f"expected 'abc' in capture, got {len(cap)} bytes: {text[:200]!r}"
        )
        assert backend.is_alive()

    try:
        asyncio.run(_inner())
    finally:
        asyncio.run(backend.stop())


# ---- write() path-routing argv assertions (mocked) -----------------------
#
# These tests pin the argv shape that TmuxBackend.write() feeds to tmux for
# each of the three routing paths. Mocking `_run_tmux` avoids needing a real
# tmux server and makes the contract with tmux explicit — if someone ever
# "simplifies" the routing back into a two-path world, these tests scream.


def _make_backend_for_write_tests() -> TmuxBackend:
    """Build a backend and mark it running without touching tmux."""
    backend = TmuxBackend(
        session_id=f"write-routing-{uuid.uuid4().hex[:6]}",
        working_dir=Path.home(),
        on_output=None,
    )
    backend._running = True  # bypass start()
    return backend


def _patch_run_tmux(backend: TmuxBackend):
    """Return an AsyncMock bound to backend._run_tmux that records argv.

    Each call is appended to `calls` as the positional `args` tuple (which
    is the argv AFTER the ``tmux -L <socket>`` prefix — exactly the contract
    we care about for routing correctness).
    """
    calls: list[tuple] = []

    async def fake(*args, stdin_bytes=None, check=True):
        calls.append(args)
        return 0, b"", b""

    backend._run_tmux = fake  # type: ignore[assignment]
    return calls


def test_tmux_backend_write_plain_text_uses_send_keys_l():
    """Plain ASCII text → send-keys -l <text> (fast path)."""
    backend = _make_backend_for_write_tests()
    calls = _patch_run_tmux(backend)

    asyncio.run(backend.write(b"hello"))

    assert len(calls) == 1, f"expected exactly 1 tmux call, got {len(calls)}"
    argv = calls[0]
    assert argv[0] == "send-keys"
    assert argv[1] == "-l"
    assert argv[2] == "-t"
    assert argv[3] == f"{backend.tmux_session}:0.0"
    assert argv[4] == "hello"


def test_tmux_backend_write_backspace_uses_hex_keys():
    """Single-byte Backspace (0x7f) → send-keys -H 7f."""
    backend = _make_backend_for_write_tests()
    calls = _patch_run_tmux(backend)

    asyncio.run(backend.write(b"\x7f"))

    assert len(calls) == 1
    argv = calls[0]
    assert argv[0] == "send-keys"
    assert argv[1] == "-H"
    assert argv[2] == "-t"
    assert argv[3] == f"{backend.tmux_session}:0.0"
    # Hex pair is the ONLY trailing argv — one byte, one pair.
    assert argv[4:] == ("7f",), f"expected hex pair '7f', got trailing {argv[4:]}"


def test_tmux_backend_write_escape_single_byte():
    """Single-byte Escape (0x1b) → send-keys -H 1b (no bracketed-paste wrap)."""
    backend = _make_backend_for_write_tests()
    calls = _patch_run_tmux(backend)

    asyncio.run(backend.write(b"\x1b"))

    assert len(calls) == 1
    argv = calls[0]
    assert argv[0] == "send-keys"
    assert argv[1] == "-H"
    assert argv[4:] == ("1b",)


def test_tmux_backend_write_arrow_sequence_no_paste_wrap():
    """Up arrow (\\x1b[A) → send-keys -H 1b 5b 41 (three hex pairs, no paste path)."""
    backend = _make_backend_for_write_tests()
    calls = _patch_run_tmux(backend)

    asyncio.run(backend.write(b"\x1b[A"))

    assert len(calls) == 1
    argv = calls[0]
    assert argv[0] == "send-keys"
    assert argv[1] == "-H"
    # Three hex pairs, one per byte: \x1b -> 1b, '[' -> 5b, 'A' -> 41
    assert argv[4:] == ("1b", "5b", "41"), f"expected 1b 5b 41, got {argv[4:]}"


def test_tmux_backend_write_ctrl_c_uses_hex_keys():
    """Ctrl+C (0x03) → send-keys -H 03 (keystroke path, NOT paste)."""
    backend = _make_backend_for_write_tests()
    calls = _patch_run_tmux(backend)

    asyncio.run(backend.write(b"\x03"))

    assert len(calls) == 1
    argv = calls[0]
    assert argv[0] == "send-keys"
    assert argv[1] == "-H"
    assert argv[4:] == ("03",)


def test_tmux_backend_write_shift_tab_uses_hex_keys():
    """Shift+Tab (\\x1b[Z) → send-keys -H 1b 5b 5a."""
    backend = _make_backend_for_write_tests()
    calls = _patch_run_tmux(backend)

    asyncio.run(backend.write(b"\x1b[Z"))

    assert len(calls) == 1
    argv = calls[0]
    assert argv[0] == "send-keys"
    assert argv[1] == "-H"
    assert argv[4:] == ("1b", "5b", "5a")


def test_tmux_backend_write_large_payload_uses_load_and_paste_buffer():
    """Large payloads (>PASTE_THRESHOLD_BYTES) → load-buffer then paste-buffer -d -p."""
    backend = _make_backend_for_write_tests()
    calls = _patch_run_tmux(backend)

    # 500 bytes of plain ASCII — no control chars, but over the threshold.
    payload = b"A" * 500
    asyncio.run(backend.write(payload))

    assert len(calls) == 2, f"paste path should issue two tmux calls, got {len(calls)}"
    load_argv, paste_argv = calls
    assert load_argv[0] == "load-buffer"
    assert "-b" in load_argv
    assert load_argv[-1] == "-"  # read stdin
    assert paste_argv[0] == "paste-buffer"
    assert "-d" in paste_argv  # delete buffer after paste
    assert "-p" in paste_argv  # bracketed paste
    assert "-b" in paste_argv
    assert "-t" in paste_argv


def test_tmux_backend_write_empty_is_noop():
    """Empty payload must NOT invoke tmux at all."""
    backend = _make_backend_for_write_tests()
    calls = _patch_run_tmux(backend)

    asyncio.run(backend.write(b""))

    assert calls == [], f"empty write must be a no-op, got {calls}"


def test_tmux_backend_write_raises_when_not_running():
    """write() before start() must raise (guard against ordering bugs)."""
    backend = TmuxBackend(
        session_id=f"not-running-{uuid.uuid4().hex[:6]}",
        working_dir=Path.home(),
        on_output=None,
    )
    # _running defaults to False.
    with pytest.raises(RuntimeError, match="not running"):
        asyncio.run(backend.write(b"hello"))


@requires_tmux
def test_tmux_backend_is_alive_lifecycle(tmux_socket_cleanup):
    """is_alive() flips False → True → False across start/stop."""
    backend = TmuxBackend(
        session_id=f"alive-{uuid.uuid4().hex[:6]}",
        working_dir=Path.home(),
        on_output=None,
        socket_name=tmux_socket_cleanup,
    )
    assert not backend.is_alive()
    try:
        asyncio.run(backend.start())
        assert backend.is_alive()
    finally:
        asyncio.run(backend.stop())
    # Give tmux a beat to reap the session.
    time.sleep(0.2)
    assert not backend.is_alive()


@requires_tmux
@pytest.mark.asyncio
async def test_tmux_backend_resize_actually_resizes_window(tmux_socket_cleanup):
    """After resize(), `tmux display-message -p '#{window_width}'` should match.

    Regression test for the headless-sizing bug: TmuxBackend used to create
    sessions without `-x/-y` and call `refresh-client -C` (which requires an
    attached client) to resize. Without an attached client the window stayed
    at its 80x24 birth size forever, so Claude CLI rendered its TUI at 80x24
    while the xterm.js client drew at the real browser geometry.

    Fix: birth the window at INITIAL_COLS x INITIAL_ROWS, set
    `window-size manual`, and use `resize-window -x -y` (server-side, works
    with zero clients) for subsequent resizes. This test locks that in.
    """
    slug = f"resize_test_{secrets.token_hex(4)}"
    wd = Path(tempfile.mkdtemp(prefix="cc_resize_"))
    backend = TmuxBackend(
        session_id=slug,
        working_dir=wd,
        on_output=None,
        socket_name=tmux_socket_cleanup,
    )
    try:
        await backend.start()

        # Initial dims must match the module-level constants.
        out = subprocess.check_output(
            [
                "tmux",
                "-L",
                backend.socket_name,
                "display-message",
                "-t",
                backend.tmux_session,
                "-p",
                "#{window_width}x#{window_height}",
            ]
        ).decode().strip()
        assert out == f"{INITIAL_COLS}x{INITIAL_ROWS}", f"initial dims wrong: {out}"

        # Trigger a resize and wait for the fire-and-forget subprocess.
        backend.resize(cols=100, rows=30)
        await asyncio.sleep(0.3)

        out = subprocess.check_output(
            [
                "tmux",
                "-L",
                backend.socket_name,
                "display-message",
                "-t",
                backend.tmux_session,
                "-p",
                "#{window_width}x#{window_height}",
            ]
        ).decode().strip()
        assert out == "100x30", f"after resize dims wrong: {out}"
    finally:
        await backend.stop()


@requires_tmux
@pytest.mark.asyncio
async def test_tmux_backend_start_honors_initial_dims(tmux_socket_cleanup):
    """start(initial_cols=100, initial_rows=30) must birth the window at 100x30.

    Regression test for the birth-size flexibility added alongside the WS
    resize handshake: callers (SessionManager via CreateSessionRequest) can
    now pass client-measured dims so the pane doesn't flash at the module
    default of 132x40 before the first resize frame arrives.
    """
    slug = f"initdims_{secrets.token_hex(4)}"
    wd = Path(tempfile.mkdtemp(prefix="cc_initdims_"))
    backend = TmuxBackend(
        session_id=slug,
        working_dir=wd,
        on_output=None,
        socket_name=tmux_socket_cleanup,
    )
    try:
        await backend.start(initial_cols=100, initial_rows=30)

        out = subprocess.check_output(
            [
                "tmux",
                "-L",
                backend.socket_name,
                "display-message",
                "-t",
                backend.tmux_session,
                "-p",
                "#{window_width}x#{window_height}",
            ]
        ).decode().strip()
        # Key assertion: NOT the default INITIAL_COLS x INITIAL_ROWS.
        assert out == "100x30", (
            f"expected 100x30 from initial_cols/initial_rows override, got {out} "
            f"(default would be {INITIAL_COLS}x{INITIAL_ROWS})"
        )
    finally:
        await backend.stop()


@requires_tmux
@pytest.mark.asyncio
async def test_tmux_backend_start_ignores_one_sided_initial_dims(tmux_socket_cleanup):
    """initial_cols alone (without initial_rows) falls back to defaults.

    Asymmetric input is treated as "not supplied" so we never pair a
    client-measured col count with a default row count (or vice versa),
    which would produce a nonsense pane shape.
    """
    slug = f"onesided_{secrets.token_hex(4)}"
    wd = Path(tempfile.mkdtemp(prefix="cc_onesided_"))
    backend = TmuxBackend(
        session_id=slug,
        working_dir=wd,
        on_output=None,
        socket_name=tmux_socket_cleanup,
    )
    try:
        # Only cols supplied — should fall back to defaults for BOTH dims.
        await backend.start(initial_cols=100, initial_rows=None)

        out = subprocess.check_output(
            [
                "tmux",
                "-L",
                backend.socket_name,
                "display-message",
                "-t",
                backend.tmux_session,
                "-p",
                "#{window_width}x#{window_height}",
            ]
        ).decode().strip()
        assert out == f"{INITIAL_COLS}x{INITIAL_ROWS}", (
            f"asymmetric dims should fall back to defaults, got {out}"
        )
    finally:
        await backend.stop()


@requires_tmux
@pytest.mark.asyncio
async def test_tmux_backend_write_ctrl_l_single_byte(tmux_socket_cleanup):
    """write(b'\\x0c') must deliver the single control byte without error.

    The WS resize handshake sends Ctrl+L (0x0c) after reshaping to force
    the foreground app to redraw at the new size. 0x0c is a short
    control byte that triggers the ``send-keys -H`` keystroke path
    (short + has control bytes). This test locks in that the single-byte
    control write completes without raising and the session stays alive.
    """
    backend = TmuxBackend(
        session_id=f"ctrll_{uuid.uuid4().hex[:6]}",
        working_dir=Path.home(),
        on_output=None,
        socket_name=tmux_socket_cleanup,
    )

    async def _inner():
        # `cat` echoes whatever we write. 0x0c on most terminals renders as
        # a form-feed which may or may not scroll — the important thing is
        # the write doesn't raise AND the pane receives a byte.
        await backend.start(command="/bin/cat")
        await asyncio.sleep(0.3)

        # Single byte, control char → paste-buffer path.
        await backend.write(b"\x0c")
        await asyncio.sleep(0.5)

        # Session must still be alive — cat would die if we'd somehow
        # corrupted the pipe. Also confirms paste-buffer didn't raise.
        assert backend.is_alive(), "pane died after Ctrl+L write"

    try:
        await _inner()
    finally:
        await backend.stop()


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
