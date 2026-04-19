"""Tests for src.core.session_backend + TmuxBackend + PTYBackend.

Run with:
    python3 -m pytest tests/test_session_backend.py -v
"""

from __future__ import annotations

import asyncio
import os
import shutil
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
from src.core.tmux_backend import TmuxBackend, _slugify, _has_control_chars
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
def test_tmux_backend_binary_safe_write(tmux_socket_cleanup):
    """Writing bytes containing 0x03 and long payloads must not corrupt.

    We write a large control-char-containing payload, then capture-pane and
    verify that tmux didn't interpret 0x03 as a signal (which would abort the
    running shell) and that we got reasonable content back.

    The test shell is `cat`, which echoes its input to the pane. Why cat?
    Because a login shell would eat our 0x03 bytes (SIGINT handling) and also
    writes a prompt we'd have to mask. `cat` just echoes.

    Strategy: start `cat`, write a payload of repeated "\\x03abc" (2000 bytes,
    way over PASTE_THRESHOLD_BYTES), send EOF, then capture the pane buffer.
    The pane should contain the literal `abc` sequences echoed back. If
    send-keys had interpreted 0x03 as ETX, `cat` would have died early and
    we'd see truncated output.
    """
    backend = TmuxBackend(
        session_id=f"binsafe-{uuid.uuid4().hex[:6]}",
        working_dir=Path.home(),
        on_output=None,
        socket_name=tmux_socket_cleanup,
    )

    async def _inner():
        # Use /bin/cat as the pane's first process — no prompt, echoes stdin.
        await backend.start(command="/bin/cat")
        # Give cat time to start up.
        await asyncio.sleep(0.3)

        payload = b"\x03abc" * 500  # 2000 bytes, control chars → paste path
        await backend.write(payload)

        # Let the paste buffer flush through the pane.
        await asyncio.sleep(0.8)

        # Capture pane contents — this is what the user would see.
        cap = backend.capture_scrollback(lines=500)

        # The paste path writes to the pane's stdin. `cat` echoes it back
        # to the pane's stdout. We should see `abc` in the captured output.
        # If 0x03 had been interpreted as ETX, cat would have died on the
        # first one and we'd see zero `abc` occurrences.
        text = cap.decode("utf-8", errors="replace")
        abc_count = text.count("abc")
        assert abc_count > 0, (
            f"expected 'abc' in capture, got {len(cap)} bytes: {text[:200]!r}"
        )

    try:
        asyncio.run(_inner())
    finally:
        asyncio.run(backend.stop())


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


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
