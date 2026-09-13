"""``GET /themes`` must not walk the theme roots on the event loop.

The route was an ``async def`` with an entirely synchronous body: two
directory scans, a ``theme.json`` read and parse per theme, and a sha256
over every declared ``effects.js``, which is a whole-file read. The
launchpad awaits this route before it paints, so for as long as it ran
the server did nothing else at all - it could not read the tmux pipe
carrying terminal output and it could not answer another request. Same
defect, same fix and same test shape as the file drawer's tree walk in
``tests/test_config_files_shallow.py``.

THREE TESTS AND ONE OF THEM IS THE CONTROL:

1.  A STRUCTURAL loop-blocking test. The stand-in scan parks until a
    coroutine beside it releases it, so it can only pass off the loop.
    Deliberately not a wall-clock threshold: this box is shared and its
    load average moves, so a timing assertion would either flake or be
    loosened until it proved nothing.
2.  A thread-identity check over a REAL scan of real theme directories,
    so the claim is made against actual filesystem work and actual
    digests rather than only against a stand-in that returns ``[]``.
3.  THE NEGATIVE CONTROL, which reproduces the pre-fix shape inline and
    asserts the heartbeat beside it does NOT advance. Without it a
    harness that could never observe starvation would pass against the
    pre-fix code and prove nothing.

WHAT IS NOT RE-ASSERTED HERE IS THE RESPONSE ITSELF.
``tests/test_themes_endpoint.py`` already drives this route end to end -
discovery, source labelling, the bundled-wins collision rule, the sort
order, the skip-and-log paths - and it runs against this code. A second
copy of those expectations here would be two records of one contract.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest


# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_themeloop_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_themeloop_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
import src.api.themes_routes as themes_routes_mod


def _write_theme(root: Path, theme_id: str, *, with_effects: bool = False) -> None:
    """Drop one valid theme directory into ``root``.

    Inputs: root - the theme root. theme_id - the directory name, which
      the manifest's ``id`` must equal. with_effects - also ship an
      ``effects.js``, so the route has a real file to sha256.
    Output: None.
    Example: _write_theme(tmp_path, "neon", with_effects=True)
    """
    theme_dir = root / theme_id
    theme_dir.mkdir(parents=True)
    manifest = {
        "id": theme_id,
        "name": theme_id.title(),
        "description": f"the {theme_id} theme",
        "cssVars": {"--x": "#000"},
    }
    if with_effects:
        manifest["effects"] = "effects.js"
        (theme_dir / "effects.js").write_text("export function init() {}\n", "utf-8")
    (theme_dir / "theme.json").write_text(json.dumps(manifest), "utf-8")


@pytest.fixture
def roots(monkeypatch, tmp_path):
    """Point both roots at fresh tmp dirs. Returns ``(bundled, user)``."""
    bundled = tmp_path / "bundled"
    user = tmp_path / "user"
    bundled.mkdir()
    user.mkdir()
    monkeypatch.setattr(themes_routes_mod, "_bundled_themes_root", lambda: bundled)
    monkeypatch.setattr(themes_routes_mod, "_user_themes_root", lambda: user)
    return bundled, user


# ---- 1. the scan must not run on the event loop -------------------------

def test_the_theme_scan_runs_off_the_event_loop(roots, monkeypatch):
    """The decisive test, and it is STRUCTURAL rather than timed.

    The stand-in scan parks until a coroutine beside it releases it. That
    coroutine stands in for the tmux pipe reader carrying a session's
    terminal output. If the scan runs on the event loop the coroutine can
    never run, the release can never happen, and the scan fails on its own
    bounded wait. If it runs in a thread the loop stays free, the
    coroutine runs, and both finish.
    """
    entered = threading.Event()
    released = threading.Event()

    def parked_scan(root, source):
        entered.set()
        if not released.wait(timeout=10.0):
            raise AssertionError(
                "the event loop never got to run while the theme scan was in "
                "progress: the scan is ON the loop"
            )
        return []

    monkeypatch.setattr(themes_routes_mod, "_scan_themes_root", parked_scan)

    async def scenario():
        task = asyncio.create_task(themes_routes_mod.list_themes())

        # The pipe reader: it must keep getting scheduled throughout.
        ticks = 0
        for _ in range(200):
            await asyncio.sleep(0.005)
            ticks += 1
            if entered.is_set():
                released.set()
                break
        return ticks, await task

    ticks, manifests = asyncio.run(scenario())
    assert entered.is_set(), "the scan never started"
    assert ticks > 0, "the loop was starved for the whole scan"
    assert manifests == []


# ---- 2. and the REAL scan, with real digests, is in a worker thread -----

def test_the_real_scan_and_its_digests_happen_in_a_worker_thread(roots):
    """The same claim against actual filesystem work, not a stand-in.

    A stand-in that returns ``[]`` proves the handoff exists; it does not
    prove the expensive part went with it. This one ships two themes with
    a real ``effects.js`` each, so the parse and the sha256 both run, and
    records which thread they ran on.
    """
    bundled, user = roots
    _write_theme(bundled, "aurora", with_effects=True)
    _write_theme(user, "neon", with_effects=True)

    scan_threads: list[int] = []
    real_scan = themes_routes_mod._scan_themes_root

    def recording_scan(root, source):
        scan_threads.append(threading.get_ident())
        return real_scan(root, source)

    themes_routes_mod._scan_themes_root = recording_scan
    try:
        async def scenario():
            return threading.get_ident(), await themes_routes_mod.list_themes()

        loop_thread, manifests = asyncio.run(scenario())
    finally:
        themes_routes_mod._scan_themes_root = real_scan

    assert len(scan_threads) == 2, "both roots should have been scanned"
    for ident in scan_threads:
        assert ident != loop_thread, (
            "the theme scan ran on the same thread as the event loop, so it "
            "is still blocking every terminal in the app"
        )
    # ...and it really did the work: two themes, each with the digest the
    # consent ladder matches a grant against.
    assert [m.id for m in manifests] == ["aurora", "neon"]
    assert all(m.effectsDigest for m in manifests)


# ---- 3. NEGATIVE CONTROL ------------------------------------------------

def test_the_loop_test_can_detect_a_scan_that_is_on_the_loop():
    """NEGATIVE CONTROL for the two tests above.

    Without this, a harness that could never observe starvation would pass
    against the pre-fix code and prove nothing. This reproduces the
    pre-fix shape inline - synchronous work inside a coroutine, which is
    exactly what the route did before ``asyncio.to_thread`` - and asserts
    the heartbeat beside it does NOT advance.
    """
    ticks = 0

    async def heartbeat():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.001)
            ticks += 1

    async def scenario():
        nonlocal ticks
        hb = asyncio.create_task(heartbeat())
        await asyncio.sleep(0.02)          # prove the heartbeat really runs
        assert ticks > 0, "the heartbeat never started, so it proves nothing"
        before = ticks
        time.sleep(0.30)                   # the pre-fix rule: sync, on the loop
        during = ticks - before
        hb.cancel()
        return during

    assert asyncio.run(scenario()) == 0, (
        "a synchronous 300ms call inside a coroutine let the loop run, so this "
        "harness cannot detect loop blocking and the tests above are worthless"
    )
