"""A superseded navigation must not reach the screen, in a real browser.

WHAT THIS EXISTS TO CATCH. Click session A, click session B before A's fetch
resolves, resolve A, and A's late completion painted into B. Its sibling
``tests/test_navigation_generation.node.mjs`` runs the same out-of-order
resolution in a vm sandbox and proves which navigation each path DECIDES to
carry out. That is a model assertion, and this project has already shipped a
feature with 282 passing state assertions that drew zero pixels.

So every assertion here is read out of a real Chromium after a real cascade,
driving the REAL ``client/js/navigation-generation.js``, the REAL
``client/js/session-sidebar-clicks.js`` and the REAL ``client/js/app.js``,
with the shipped ``activateRow`` doing the switching. What is stubbed is the
terminal controller and the network, and the network is stubbed precisely so
the TEST decides which fetch answers first - that order is the entire scenario
and no amount of real waiting can express it.

THE THREE THINGS MEASURED, and why each is on screen rather than in a variable:

* The session name painted into the terminal header, which is what a human
  reads to know which conversation they are in.
* Which screen carries ``.active``, because a superseded navigation that still
  swapped the screen would leave the user looking at the right name on the
  wrong page.
* The controller's recorded connect calls, which is the write that cannot be
  taken back: a socket opened for the wrong session streams another
  conversation's bytes.

THE POSITIVE CONTROL IS LOAD-BEARING. A guard that refused every navigation
would satisfy "A did not paint" perfectly and make the app unusable, so the
first case resolves in order and asserts the switch DOES happen.

If Playwright or its Chromium is unavailable these tests SKIP, and the skip
says the rendering was NOT measured. A skip is the third outcome; it is not a
pass.
"""

from __future__ import annotations

import os
import socket
import tempfile
import threading
import time
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_nav_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_nav_logs_"))
os.environ.setdefault("TOTP_SECRET", "JBSWY3DPEHPK3PXP")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-not-a-real-one-32b")

pytest.importorskip(
    "playwright.sync_api",
    reason=(
        "playwright is not installed, so NOTHING about what this page renders "
        "was measured. This is a could-not-evaluate, not a pass."
    ),
)

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import HTMLResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent

VIEWPORT = {"width": 900, "height": 700}

#: A page carrying the REAL navigation token, the REAL sidebar click router and
#: the REAL App screen-entry methods, plus the minimum DOM they touch. The
#: network is a deferred stub so the test picks the resolution order; nothing
#: in the navigation chain itself is stubbed.
HARNESS_HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  .screen { display: none; }
  .screen.active { display: block; }
  #header-title-text { font: 16px monospace; }
</style>
</head>
<body>
  <div id="auth-screen" class="screen"></div>
  <div id="launchpad-screen" class="screen"></div>
  <div id="terminal-screen" class="screen">
    <span id="header-title-text"></span>
  </div>
  <div id="archive-screen" class="screen"></div>

  <script src="/static/js/navigation-generation.js"></script>
  <script src="/static/js/session-sidebar-clicks.js"></script>
  <script src="/static/js/app.js"></script>
  <script>
    // app.js registers a window 'load' handler calling App.init(), which wants
    // the whole authenticated app. Neutralise it BEFORE load fires. This is
    // not re-running anything: it stops an init from running a FIRST time in
    // an environment that cannot support it.
    window.App.init = function () {};

    // ---- the network, under the test's control -----------------------
    // Each getSession() hands back a promise the test resolves by hand. The
    // ORDER those resolve in is the entire scenario, and a real fetch could
    // not express it.
    window.__pending = {};
    window.API = {
      getSession: function (id) {
        return new Promise(function (resolve) { window.__pending[id] = resolve; });
      },
      adoptSession: function () { return Promise.resolve({ session: {} }); }
    };
    window.__resolveSession = function (id, payload) {
      var r = window.__pending[id];
      delete window.__pending[id];
      r(payload);
    };

    // ---- the write that cannot be taken back -------------------------
    // Every socket the controller would open is recorded instead. A
    // superseded navigation reaching this list is the bug.
    window.__connects = [];
    window.TerminalController = {
      term: {},
      pauseForHome: function () {},
      reconnectToExistingSession: function (info) {
        window.__connects.push((info.session && info.session.id) || null);
        return Promise.resolve();
      },
      connectToSession: function (s) {
        window.__connects.push(s && s.id);
        return Promise.resolve();
      }
    };

    // ---- collaborators app.js reaches for ----------------------------
    window.ScreenChrome = { apply: function () {} };
    window.ThemeNavigation = { applyForSession: function () {},
                               applyForGlobal: function () {} };
    window.SessionSidebar = { show: function () {}, hide: function () {},
                              setActiveSession: function () {} };
    window.DPad = { floatingButton: {}, init: function () {},
                    show: function () {}, hide: function () {} };
    window.SlashCommandsModal = { button: {},
        init: function () { return Promise.resolve(); },
        show: function () {}, hide: function () {} };
    window.Launchpad = { loadProjects: function () {}, init: function () {},
                         renderLaunchpadUI: function () {} };
    window.Router = { resetToLauncher: function () {} };

    var app = window.App;
    app.logoutBtn = document.createElement('button');
    app.settingsBtn = document.createElement('button');
    app.configEditorBtn = document.createElement('button');
    app._placeStatusLight = function () {};
    app._syncSessionUrl = function () {};
    app._showArchiveIfDeepLinked = function () { return false; };
    app.focusTerminal = function () {};
    app.currentScreen = 'launchpad';

    // ---- the gesture ------------------------------------------------
    // The SHIPPED activateRow, given a row shaped exactly as the sidebar
    // builds one. Returns the promise so the test can await each click.
    window.__ctrl = { _activeTmuxName: null, _closeAfterSwitch: function () {} };
    window.__click = function (name, sessionId) {
      return window.SessionSidebarClicks.activateRow(
        window.__ctrl, { dataset: { name: name, sessionId: sessionId } });
    };
    // PLAYWRIGHT'S evaluate() AWAITS A RETURNED PROMISE, and an
    // assignment expression evaluates TO the value assigned. So
    // "start a click and do not wait for it" has to hand back
    // undefined, and waiting for one has to be its own call. Getting
    // this wrong hangs the test on the very fetch it is deliberately
    // holding open.
    window.__runs = {};
    window.__start = function (key, name, sessionId) {
      window.__runs[key] = window.__click(name, sessionId);
    };
    window.__settle = function (key) {
      return window.__runs[key].then(function () { return true; });
    };
    window.__ready = true;
  </script>
</body>
</html>
"""


def _free_port() -> int:
    """Pick a port nothing is listening on.

    Never 5000 (macOS AirPlay) and never this project's default: the OS picks
    from the ephemeral range instead.

    Returns:
        A currently-free TCP port.
    """
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture(scope="module")
def live_harness():
    """Serve the real client assets and the harness page over real HTTP.

    Yields:
        The base URL of the running server.
    """
    import uvicorn

    app = FastAPI()

    @app.get("/")
    def harness() -> HTMLResponse:
        """The harness page."""
        return HTMLResponse(HARNESS_HTML)

    app.mount(
        "/static",
        StaticFiles(directory=str(REPO_ROOT / "client")),
        name="static",
    )

    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.time() + 15
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    if not server.started:
        pytest.fail("the test server did not start, so nothing was measured")

    yield f"http://127.0.0.1:{port}"

    server.should_exit = True
    thread.join(timeout=10)


@pytest.fixture(scope="function")
def page(live_harness):
    """A real Chromium page with the harness loaded.

    Yields:
        The Playwright page.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as exc:  # noqa: BLE001 - reported, never swallowed
            pytest.skip(
                f"chromium could not launch ({exc}), so NOTHING about what "
                "this page renders was measured."
            )
        context = browser.new_context(viewport=VIEWPORT)
        pg = context.new_page()
        pg.goto(live_harness)
        pg.wait_for_function("window.__ready === true")

        assert pg.evaluate("document.hidden") is False, (
            "the page reports document.hidden; a backgrounded tab freezes "
            "rendering and makes every measurement here meaningless"
        )
        yield pg
        context.close()
        browser.close()


def _painted_title(page) -> str:
    """Read the session name a human would actually see in the header.

    Read from the rendered element rather than from any model value, because a
    navigation that decided correctly and never painted is exactly the defect
    this file exists to catch.

    Args:
        page: The Playwright page.

    Returns:
        The header's trimmed text content.
    """
    return page.evaluate(
        "() => (document.getElementById('header-title-text').textContent || '').trim()"
    )


def _active_screen(page) -> str:
    """Which screen currently carries the .active class.

    Args:
        page: The Playwright page.

    Returns:
        The id of the active screen element, or '' when none is active.
    """
    return page.evaluate(
        "() => { const el = document.querySelector('.screen.active');"
        " return el ? el.id : ''; }"
    )


def _info(session_id: str, label: str) -> dict:
    """A SessionInfo wrapper shaped as GET /sessions returns one.

    The id lives on the nested Session and the tmux name on the wrapper -
    reading the wrong level is the single most repeated bug in this project, so
    the fixture carries both levels honestly.

    Args:
        session_id: The inner Session's id.
        label: The human name the header should paint.

    Returns:
        The wrapper dict.
    """
    return {
        "session": {"id": session_id, "tmux_session": f"cloude_{label}"},
        "tmux_session": f"cloude_{label}",
        "label": label,
    }


def test_a_switch_resolved_in_order_really_paints(page):
    """POSITIVE CONTROL: without it every refusal below could be a broken app.

    A guard that refused every navigation would satisfy each "A did not paint"
    assertion perfectly while making the app unusable.
    """
    page.evaluate("__start('A', 'cloude_alpha', 'ses_a')")
    page.evaluate(
        "(p) => window.__resolveSession('ses_a', p)", _info("ses_a", "alpha")
    )
    page.evaluate("__settle('A')")

    assert _painted_title(page) == "alpha"
    assert _active_screen(page) == "terminal-screen"
    assert page.evaluate("window.__connects") == ["ses_a"]


def test_a_late_completion_never_paints_over_the_session_the_user_moved_to(page):
    """THE DECISIVE CASE, in real pixels.

    Click A, click B before A settles, let B answer, then let A answer late. A
    owns nothing on screen and opened no socket.
    """
    page.evaluate("__start('A', 'cloude_alpha', 'ses_a')")
    page.evaluate("__start('B', 'cloude_beta', 'ses_b')")

    # B answers first, so B is the session on screen.
    page.evaluate(
        "(p) => window.__resolveSession('ses_b', p)", _info("ses_b", "beta")
    )
    page.evaluate("__settle('B')")
    assert _painted_title(page) == "beta"

    # NOW A's fetch comes back, late.
    page.evaluate(
        "(p) => window.__resolveSession('ses_a', p)", _info("ses_a", "alpha")
    )
    page.evaluate("__settle('A')")

    assert _painted_title(page) == "beta", (
        "session A resolved after the user had moved to B and repainted the "
        "header, which is the bug the navigation token exists to make "
        "impossible"
    )
    assert _active_screen(page) == "terminal-screen"
    assert page.evaluate("window.__connects") == ["ses_b"], (
        "and A must not have opened a socket - that is the write that cannot "
        "be taken back, because it streams another conversation's bytes"
    )


def test_the_last_click_wins_even_when_it_answers_first(page):
    """A resolving BEFORE B must still lose. Order of clicks decides, not
    order of answers."""
    page.evaluate("__start('A', 'cloude_alpha', 'ses_a')")
    page.evaluate("__start('B', 'cloude_beta', 'ses_b')")

    page.evaluate(
        "(p) => window.__resolveSession('ses_a', p)", _info("ses_a", "alpha")
    )
    page.evaluate("__settle('A')")
    assert _painted_title(page) == "", (
        "A had already been superseded when it answered, so it must not have "
        "painted anything at all"
    )

    page.evaluate(
        "(p) => window.__resolveSession('ses_b', p)", _info("ses_b", "beta")
    )
    page.evaluate("__settle('B')")

    assert _painted_title(page) == "beta"
    assert page.evaluate("window.__connects") == ["ses_b"]


def test_a_then_b_then_a_again_and_the_first_visit_still_loses(page):
    """Two navigations to the SAME session are two generations.

    This is why the token is a counter and not a target identity: comparing
    session ids would let the FIRST visit to A be satisfied by its own late
    fetch, and the screen it would paint into was torn down in between.
    """
    page.evaluate("__start('A1', 'cloude_alpha', 'ses_a')")
    page.evaluate("__start('B', 'cloude_beta', 'ses_b')")
    page.evaluate(
        "(p) => window.__resolveSession('ses_b', p)", _info("ses_b", "beta")
    )
    page.evaluate("__settle('B')")

    # Back to A, on a fresh row carrying a fresh id.
    page.evaluate("__start('A2', 'cloude_alpha', 'ses_a2')")
    page.evaluate(
        "(p) => window.__resolveSession('ses_a2', p)", _info("ses_a", "alpha")
    )
    page.evaluate("__settle('A2')")
    assert _painted_title(page) == "alpha"

    # The FIRST visit to A finally answers, carrying a name that would be
    # visible if it painted.
    page.evaluate(
        "(p) => window.__resolveSession('ses_a', p)",
        _info("ses_a", "alpha-stale"),
    )
    page.evaluate("__settle('A1')")

    assert _painted_title(page) == "alpha", (
        "the first visit to A must not be satisfied by its own late fetch, "
        "even though the user is back in A - the screen was rebuilt in between"
    )
    assert page.evaluate("window.__connects") == ["ses_b", "ses_a"]


def test_going_home_stops_an_in_flight_session_entry_from_painting(page):
    """Leaving is a navigation too, and it is the half that is easy to forget.

    A session entry still resolving when the user goes home must not paint that
    session over the launcher a moment later.
    """
    page.evaluate("__start('A', 'cloude_alpha', 'ses_a')")
    page.evaluate("window.App.showLaunchpad()")
    assert _active_screen(page) == "launchpad-screen"

    page.evaluate(
        "(p) => window.__resolveSession('ses_a', p)", _info("ses_a", "alpha")
    )
    page.evaluate("__settle('A')")

    assert _active_screen(page) == "launchpad-screen", (
        "the session resolved after the user went home and swapped the screen "
        "out from under them"
    )
    assert page.evaluate("window.__connects") == []
