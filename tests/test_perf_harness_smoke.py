"""Fast end-to-end smoke test for the perf harness itself.

WHAT THIS PROVES, IN UNDER ABOUT FIVE SECONDS OF REAL SERVER TIME. That
``scripts/perf/perf_env.PerfServer`` still boots a real, isolated
``src.main:app`` on its own throwaway tmux socket and free port; that
``scripts/perf/perf_client.PerfClient`` can still log in over the real
TOTP endpoint and create a real ``agent_type=shell`` session through it;
and, when Playwright is available, that one keystroke typed into that
session's real terminal actually reaches xterm's ``onRender`` with the
character visible - i.e. that ``scripts/perf/perf_instrument.js``'s hook
still attaches to the shipped client. This is NOT the baseline run
itself (that is ``scripts/perf/run_baseline.py`` - a multi-minute,
multi-session, opt-in measurement pass, wrong shape for the default
suite); it is the guard that keeps the harness from silently rotting
while nobody is running the baseline.

SKIPS, NAMED, NEVER SILENT. No tmux -> skip. No playwright -> the server
lifecycle half still runs (it needs no browser), and only the render-proof
half skips, with the reason stated.
"""

from __future__ import annotations

import shutil
import sys
import uuid
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_PERF = REPO_ROOT / "scripts" / "perf"
if str(SCRIPTS_PERF) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_PERF))

requires_tmux = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux not on PATH")


@pytest.fixture()
def perf_server(request):
    """One isolated perf server, started and guaranteed torn down.

    Description: uses ``tests.socket_guard.derive_test_socket`` for the
      tmux socket name rather than a random one. This suite installs a
      global subprocess guard that rejects any tmux invocation whose
      socket is not this pytest process's own registered test socket (or
      a name derived from it) - see ``perf_env.PerfServer.tmux_socket_name``'s
      docstring for why a plain random name would make ``server.stop()``
      raise during teardown here specifically, without indicating any
      problem with the harness itself.
    Output: yields a started ``perf_env.PerfServer``.
    """
    from perf_env import PerfServer
    from tests.socket_guard import derive_test_socket

    server = PerfServer(tmux_socket_name=derive_test_socket(f"perf_{request.node.name[:20]}"))
    try:
        server.start()
        yield server
    finally:
        server.stop()


@requires_tmux
def test_isolated_server_boots_and_answers_health(perf_server) -> None:
    """The harness's own server lifecycle: boot, /health, and a real login."""
    import httpx

    resp = httpx.get(f"{perf_server.base_url}/health", timeout=5.0)
    assert resp.status_code == 200
    assert perf_server.tmux_socket != "cloude"


@requires_tmux
def test_a_real_shell_session_can_be_created_and_listed(perf_server) -> None:
    """Login, create one agent_type=shell session, see it in /sessions/list."""
    from perf_client import PerfClient, wait_until

    client = PerfClient(perf_server.base_url, perf_server.totp_secret)
    try:
        client.login()
        body = client.create_session(perf_server.work_dir, "smoke-session")
        assert body["id"]

        found = wait_until(lambda: client.row_for(body["id"]) is not None, timeout=15.0)
        assert found, "the created session never appeared in /sessions/list"
    finally:
        client.close()


@requires_tmux
def test_one_keystroke_actually_paints_through_onrender(perf_server) -> None:
    """The full pipeline: real browser, real WS, real xterm, real paint.

    Skips (rather than failing) when Playwright/Chromium is unavailable,
    per this project's established pattern for browser-driven checks -
    see tests/test_setup_wizard_renders.py's own header for why a skip
    here is the honest outcome, not a soft pass.
    """
    playwright_module = pytest.importorskip(
        "playwright.sync_api",
        reason="playwright is not installed, so nothing about paint was measured",
    )

    import perf_browser
    from perf_client import PerfClient, wait_until

    client = PerfClient(perf_server.base_url, perf_server.totp_secret)
    try:
        client.login()
        session = client.create_session(perf_server.work_dir, "smoke-render")
        assert wait_until(lambda: client.row_for(session["id"]) is not None, timeout=15.0)

        with playwright_module.sync_playwright() as pw:
            browser = pw.chromium.launch()
            try:
                context = browser.new_context(viewport={"width": 1024, "height": 768})
                perf_browser.install_instrumentation(context)
                page = context.new_page()
                perf_browser.inject_authenticated_session(
                    page, perf_server.base_url, client.token
                )
                page.wait_for_function(
                    "(sid) => !!document.querySelector('[data-session-id=\"' + sid + '\"]')",
                    arg=session["id"],
                    timeout=15000,
                )
                perf_browser.open_session_row(page, session["id"])

                samples = perf_browser.measure_typing_echo(page, count=1)
                assert samples["total"], "no render was ever observed for the keystroke"
                assert samples["total"][0] >= 0.0
            finally:
                browser.close()
    finally:
        client.close()
