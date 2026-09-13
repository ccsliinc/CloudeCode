"""THE RATCHET. The hook-event subsystem may not come back by accident.

WHY A TEST AND NOT A NOTE. This line and the other party's line both ship
into one codebase, and the other line still carries the hook route, the
hook settings installer and the per-session idle watcher. A merge from it
compiles cleanly: a re-added route module is a new file, a re-added
router line is one line in an aggregator, and neither conflicts with
anything here. The deletion has no other defence.

WHAT WAS DELETED, ON 2026-09-13, AND WHY. CloudeCode learned a session's
state by making Claude Code POST every lifecycle event to a loopback
endpoint. ``CLOUDECODE_SESSION_ID`` is a PANE-WIDE environment variable,
so the parent agent and every background agent it spawned posted under
one session id. Measured over 50.8 hours of the live server log: 501
toasts raised, and 410 of the 459 attributable ones fired while the
transcript's own turn-end record said background agents were still
pending. A channel wrong nine times in ten gets muted, and then the real
ones are lost too. The replacement reads what the harness already writes
to disk (``src/core/attention/``) and asks the agent for nothing.

HOW THESE CHECKS PROVE THEY CAN GO RED. Each one names a concrete string
or attribute and asserts its ABSENCE across a scan whose SUBJECT IS
ASSERTED FIRST: the route scan fails if it finds no Python under ``src``
to read, and the app scan fails if the app exposes no routes at all. A
check that passes because it looked at nothing is the most repeated
failure shape in this project, so the emptiness of the haystack is
checked before the absence of the needle.
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_nh_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_nh_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core import claude_hooks

SRC = ROOT / "src"

#: The path the hook subprocess POSTed to. Spelled here as the literal a
#: grep would look for, because a route that answered a DIFFERENT path
#: would be a different subsystem and is not what this guards.
HOOK_PATH = "/hooks/claude-event"

#: Matches the line that MOUNTS a path, so a docstring or a comment
#: naming the old endpoint is not mistaken for one serving it. The URL
#: itself is still spelled in two live places on purpose: the env var
#: ``CLOUDECODE_HOOK_URL`` is written into every pane by
#: ``get_env_for_spawn``, and it is inert precisely because nothing
#: installs a hook to call it any more.
ROUTE_DECORATOR = re.compile(
    r"@\w+\.(get|post|put|patch|delete|api_route|websocket)\s*\("
)

#: The modules that carried the subsystem. Named rather than globbed so a
#: re-add under one of these exact names is caught by name.
DELETED_MODULES = (
    "src/api/hook_event_routes.py",
    "src/api/hook_event_signals.py",
    "src/core/hook_toast_gate.py",
    "src/core/notifications/idle_watcher.py",
)


def _python_files() -> list[Path]:
    """Every Python file under ``src``, with the haystack asserted.

    Description: the emptiness check is the point. A scan that walked a
      wrong or missing directory would find no hook route and report a
      pass, which is the green-because-it-looked-at-nothing failure.
    Inputs: none.
    Output: list[Path] - never empty.
    """
    files = sorted(SRC.rglob("*.py"))
    assert len(files) > 100, (
        f"only {len(files)} python files found under {SRC}; the scan below "
        f"would pass by looking at nothing"
    )
    return files


def test_no_module_declares_a_route_for_the_hook_event_path():
    """No file under ``src`` MOUNTS the hook endpoint's path.

    Reads the source rather than the route table so a module that is
    never included in the app is caught too. The match is deliberately
    narrow - the path has to appear on a route-decorator line - because
    the URL is still legitimately spelled in the env var the spawn path
    writes, and a scan that failed on a mention would have to be
    weakened until it stopped failing on anything.
    """
    scanned = 0
    offenders = []
    for path in _python_files():
        text = path.read_text(encoding="utf-8")
        if HOOK_PATH not in text:
            continue
        for line in text.splitlines():
            scanned += 1
            if HOOK_PATH in line and ROUTE_DECORATOR.search(line):
                offenders.append(f"{path.relative_to(ROOT)}: {line.strip()}")
    assert offenders == [], (
        f"the hook event path {HOOK_PATH!r} is mounted again by "
        f"{offenders}; the endpoint was deleted on 2026-09-13 and the "
        f"session state now comes from src/core/attention/"
    )


def test_the_built_app_serves_no_hook_event_route():
    """The live route table, which is what actually answers a request.

    Stronger than the source scan and weaker in a different direction -
    a route mounted under an unexpected prefix still shows up here - so
    the two are kept side by side.
    """
    from src.main import app

    paths = [getattr(route, "path", "") for route in app.routes]
    assert len(paths) > 20, (
        f"the app exposes only {len(paths)} routes; this assertion would "
        f"pass by looking at nothing"
    )
    offenders = [path for path in paths if "hooks" in path]
    assert offenders == [], f"a hook route is mounted again: {offenders}"


@pytest.mark.parametrize("relative", DELETED_MODULES)
def test_the_deleted_modules_are_still_deleted(relative):
    """Each module that carried the subsystem stays absent."""
    assert not (ROOT / relative).exists(), (
        f"{relative} is back; it was deleted on 2026-09-13 with the rest "
        f"of the hook-event subsystem"
    )


def test_claude_hooks_exports_no_block_builder():
    """The settings installer cannot return under any of its own names.

    Duplicated deliberately from ``tests/test_claude_hooks.py``: that
    file is the strip suite and could itself be replaced by a merge,
    while this one exists only to say no.
    """
    for name in (
        "ensure_hook_settings",
        "_build_hook_block",
        "_build_managed_command",
        "_MANAGED_EVENTS",
    ):
        assert not hasattr(claude_hooks, name), (
            f"claude_hooks.{name} is back; hooks are never installed now, "
            f"and strip_managed_hooks only removes what an older build wrote"
        )
    assert hasattr(claude_hooks, "strip_managed_hooks"), (
        "strip_managed_hooks is gone, so an upgraded install would keep "
        "the block an older build wrote, forever"
    )


def test_the_session_manager_records_no_hook_events():
    """The manager's hook-event entry points stay gone.

    ``record_hook_event`` and the three tracker passthroughs beside it
    existed only for the route. Their return would mean the route is on
    its way back, or that something else started feeding the deleted
    state machine.
    """
    from src.core.session_manager import SessionManager

    for name in (
        "record_hook_event",
        "subagent_depth",
        "subagent_wait_active",
        "should_suppress_idle_notification",
        "idle_watcher",
    ):
        assert not hasattr(SessionManager, name), (
            f"SessionManager.{name} is back; it was deleted on 2026-09-13 "
            f"with the hook-event subsystem"
        )
