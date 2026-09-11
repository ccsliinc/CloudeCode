"""A pinned terminal must keep its palette on re-entry, in real pixels.

WHAT THIS EXISTS TO CATCH, reported by the owner on 2026-09-09 with
screenshots: a session pinned to snes rendered snes colours the moment the
theme was picked, and a DARK terminal inside a still-snes page after leaving
the session and coming back. Only the terminal reverted.

The cause was two writers on one surface. ``client/js/theme-navigation.js``
painted the session's pin, then ``client/js/app.js`` called
``Themes.applySession(agent_type)``, which painted the AGENT's manifest over
the top. app.js always ran last, so the agent always won.

WHY A BROWSER AND NOT THE SANDBOX. Its sibling
``tests/test_terminal_theme_survives_agent.node.mjs`` runs the same
navigations against the real registry in a vm and proves which palette OBJECT
reaches the xterm subscribers. That is still a model assertion: a vm has no
renderer, no cascade and no canvas. The defect here was visible precisely
because pixels disagreed with the model, so the decisive assertions below
sample the PNG Chromium produced and compare it against the shipped
``client/css/themes/snes/theme.json``.

WHAT IS REAL HERE, END TO END: the vendored xterm.js and its addons, a real
``Terminal`` built by the shipped ``TerminalController.initTerminal()``, the
real ``client/js/terminal-background-opacity.js`` adapter, the real theme
registry, the real navigation module and the real ``App.showTerminal`` /
``App.returnToExistingTerminal``. Only the controller's two NETWORK entry
points are replaced, so no WebSocket is opened and no tmux pane anywhere is
touched; every line that decides or applies a colour is the shipped one.

THE TRAPS THIS FILE AVOIDS ON PURPOSE

* Nothing samples a glyph edge. Antialiasing makes a glyph's border a blend of
  foreground and background, so a naive sample reads a colour that is in
  neither palette. Every foreground measurement writes FULL BLOCK (U+2588) and
  reads the centre of that cell, which is pure foreground by construction.
* Nothing asserts on ``background`` alone. A partial palette merge that fixed
  the background and left stale ANSI colours behind would satisfy a
  background-only check and still look wrong to a human, so representative
  ANSI swatches are measured too.
* Nothing sleeps a guessed interval. A write is awaited through xterm's own
  completion callback and the frame is awaited through two animation frames.
* The opacity adapter is measured rather than bypassed. It is the ONE
  permitted transform between a manifest and the screen, and the check that it
  still only touches the background is what would catch a second transform
  being introduced here.

If Playwright or its Chromium is unavailable these tests SKIP, and the skip
message says the rendering was NOT measured. A skip is the third outcome; it
is not a pass.
"""

from __future__ import annotations

import io
import json
import os
import socket
import tempfile
import threading
import time
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_termtheme_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_termtheme_logs_"))
os.environ.setdefault("TOTP_SECRET", "JBSWY3DPEHPK3PXP")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-not-a-real-one-32b")

pytest.importorskip(
    "playwright.sync_api",
    reason=(
        "playwright is not installed, so NOTHING about what this terminal "
        "renders was measured. This is a could-not-evaluate, not a pass."
    ),
)

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import HTMLResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent

VIEWPORT = {"width": 1100, "height": 800}

#: The themes this file drives. Read off disk rather than invented, because
#: the point is that the SHIPPED snes palette survives; a fixture palette
#: would prove the machinery moves some colour around and nothing more.
THEME_IDS = ("claude", "snes", "matrix")

#: Maximum per-channel difference between a sampled pixel and the manifest
#: colour it must match. Chromium composites and rounds; an exact equality
#: would be flaky for reasons that have nothing to do with the theme.
CHANNEL_TOLERANCE = 6


def _manifest(theme_id: str) -> dict:
    """Read one shipped theme manifest off disk.

    Args:
        theme_id: The theme's directory name under ``client/css/themes``.

    Returns:
        The manifest dict, marked ``source: 'builtin'`` exactly as the server
        marks a bundled theme.
    """
    path = REPO_ROOT / "client" / "css" / "themes" / theme_id / "theme.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["source"] = "builtin"
    return data


MANIFESTS = {theme_id: _manifest(theme_id) for theme_id in THEME_IDS}
SNES = MANIFESTS["snes"]
CLAUDE = MANIFESTS["claude"]


def _hex_to_rgb(value: str) -> tuple[int, int, int]:
    """Convert a ``#rrggbb`` manifest colour to a 0-255 RGB triple.

    Args:
        value: A six-digit hex colour, with the leading hash.

    Returns:
        The (r, g, b) triple.
    """
    raw = value.lstrip("#")
    return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16))


#: The harness page. Loads the vendored xterm, the real opacity adapter, the
#: real terminal controller and the real theme chain, plus the minimum DOM and
#: collaborator stubs app.js reaches for.
HARNESS_HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/static/vendor/xterm/xterm.css" />
<style>
  body { margin: 0; background: #808080; }
  .screen { display: none; }
  .screen.active { display: block; }
  /* A fixed box so the terminal has a stable geometry to sample. */
  #terminal { width: 900px; height: 500px; }
</style>
</head>
<body>
  <div id="auth-screen" class="screen"></div>
  <div id="launchpad-screen" class="screen"></div>
  <div id="archive-screen" class="screen"></div>
  <div id="terminal-screen" class="screen">
    <div id="terminal"></div>
  </div>

  <script src="/static/vendor/xterm/xterm.js"></script>
  <script src="/static/vendor/xterm/xterm-addon-fit.js"></script>
  <script src="/static/vendor/xterm/xterm-addon-webgl.js"></script>
  <script src="/static/vendor/xterm/xterm-addon-unicode11.js"></script>
  <script src="/static/js/terminal-background-opacity.js"></script>
  <!-- The two bounded waits terminal.js uses to decide the xterm bundle
       has loaded and the container can be measured. A real dependency in
       index.html, so it is loaded here too: without it this page measures
       terminal.js's degraded fallback rather than the code that runs in
       the browser. -->
  <script src="/static/js/terminal-readiness.js"></script>
  <script src="/static/js/terminal.js"></script>
  <script src="/static/js/themes/registry.js"></script>
  <script src="/static/js/theme-navigation.js"></script>
  <script src="/static/js/app.js"></script>
  <script>
    // app.js registers a window 'load' handler that calls App.init(), which
    // wants the whole authenticated app. Neutralise it BEFORE load fires.
    // This stops an init from running a first time in an environment that
    // cannot support it; nothing here re-runs an init to see whether it ran.
    window.App.init = function () {};

    // The REAL terminal controller, with only its two network entry points
    // replaced. initTerminal() - which builds the xterm instance, attaches
    // the opacity adapter and subscribes to the theme registry - is the
    // shipped one and is what every assertion below measures.
    window.TerminalController.connectToSession = function () { return Promise.resolve(); };
    window.TerminalController.reconnectToExistingSession = function () { return Promise.resolve(); };
    window.TerminalController.pauseForHome = function () {};

    // Collaborator stubs. The theme and terminal chain below them is real.
    window.ScreenChrome = { apply: function () {} };
    window.SessionSidebar = { show: function () {}, hide: function () {},
                              setActiveSession: function () {} };
    window.DPad = { floatingButton: {}, init: function () {},
                    show: function () {}, hide: function () {} };
    window.SlashCommandsModal = { button: {},
        init: function () { return Promise.resolve(); },
        show: function () {}, hide: function () {} };
    window.Launchpad = { loadProjects: function () { return Promise.resolve(); },
        render: function () { return Promise.resolve(); },
        init: function () { return Promise.resolve(); },
        show: function () { return Promise.resolve(); },
        renderLaunchpadUI: function () {} };
    window.Router = { resetToLauncher: function () {} };

    var app = window.App;
    app.logoutBtn = document.createElement('button');
    app.settingsBtn = document.createElement('button');
    app.configEditorBtn = document.createElement('button');
    app._placeStatusLight = function () {};
    app._syncSessionUrl = function () {};
    app._consumeStashedArchiveRoute = function () { return false; };
    app.focusTerminal = function () {};
    app.currentScreen = 'launchpad';

    // Themes.init() is called EXACTLY ONCE, here. Tests never call it again.
    window.__themesReady = window.Themes.init();
  </script>
</body>
</html>
"""


def _free_port() -> int:
    """Pick a port nothing is listening on.

    Never 5000 (macOS AirPlay) and never this project's default - the OS picks
    from the ephemeral range instead.

    Returns:
        A currently-free TCP port.
    """
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture(scope="module")
def live_harness():
    """Serve the real client assets and the real theme manifests over HTTP.

    Yields:
        The base URL of the running server.
    """
    import uvicorn

    app = FastAPI()

    @app.get("/api/v1/themes")
    def themes() -> JSONResponse:
        """The manifest list the real registry fetches on init."""
        return JSONResponse(list(MANIFESTS.values()))

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
    """A real Chromium page with the harness loaded and themes initialised.

    The user's global theme is seeded into localStorage BEFORE the page that
    reads it loads, so every run starts from a known global choice rather than
    whatever a previous test left behind.

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
                "this terminal renders was measured."
            )
        context = browser.new_context(viewport=VIEWPORT, device_scale_factor=1)
        pg = context.new_page()
        pg.goto(live_harness)
        pg.evaluate("localStorage.setItem('cloude.theme', 'claude')")
        # Refuse every theme's effects.js so the consent modal never appears.
        # Effects consent has its own suite; what is under test here is the
        # palette, and a modal waiting for a click would measure nothing.
        pg.evaluate(
            "(value) => localStorage.setItem('cloude.themeJsAllowlist', value)",
            json.dumps({theme_id: False for theme_id in THEME_IDS}),
        )
        pg.goto(live_harness)
        pg.wait_for_function("window.__themesReady !== undefined")
        pg.evaluate("window.__themesReady")

        assert pg.evaluate("document.hidden") is False, (
            "the page reports document.hidden; a backgrounded tab freezes "
            "rendering and makes every measurement here meaningless"
        )
        yield pg
        context.close()
        browser.close()


def _set_effect_status(page, status: str) -> None:
    """Declare whether an animated theme background is confirmed on screen.

    ``client/js/terminal-background-opacity.js`` reads this attribute to
    decide whether the terminal may render translucent. Setting it drives the
    adapter's own MutationObserver, so this exercises the shipped path rather
    than bypassing it.

    Args:
        page: The Playwright page.
        status: One of the statuses effects-base publishes - `running`,
            `paused` and `static` mean a frame is on the canvas; `inactive`
            and the rest mean nothing is behind the terminal.
    """
    page.evaluate(
        "(value) => { document.documentElement.dataset.themeEffects = value; }",
        status,
    )
    _settle_frames(page)


def _session_info(name: str, pin: str | None, agent: str | None) -> dict:
    """Build a ``/sessions/list`` style SessionInfo wrapper.

    ``pinned_theme``, ``tmux_session`` and ``agent_type`` sit on the WRAPPER;
    ``id`` sits on the nested ``.session``. Shaped like the real payload rather
    than flattened, because reading the wrong level is this project's most
    repeated bug.

    Args:
        name: Bare tmux session name.
        pin: The session's pinned theme id, or None when unpinned.
        agent: The session's agent id, or None.

    Returns:
        The SessionInfo dict.
    """
    return {
        "tmux_session": name,
        "pinned_theme": pin,
        "agent_type": agent,
        "label": name,
        "session": {"id": name, "working_dir": "/tmp", "pty_pid": 1},
    }


def _enter(page, info: dict, first_time: bool = False) -> None:
    """Drive the REAL session-entry navigation and wait for it to settle.

    Args:
        page: The Playwright page.
        info: A SessionInfo wrapper from :func:`_session_info`.
        first_time: True to use ``App.showTerminal`` (the first-attach path,
            which builds the xterm instance), False to use
            ``App.returnToExistingTerminal`` (the sidebar's switch path).
    """
    method = "showTerminal" if first_time else "returnToExistingTerminal"
    page.evaluate(
        """async (args) => {
            await window.App[args.method](args.info, {});
        }""",
        {"method": method, "info": info},
    )
    _settle_frames(page)


def _settle_frames(page) -> None:
    """Wait for two consecutive animation frames.

    A palette assigned to ``term.options.theme`` reaches the canvas on the
    next render, so a screenshot taken in the same task can legitimately show
    the previous frame. Waiting on frames waits on the renderer rather than on
    a guessed sleep.

    Args:
        page: The Playwright page.
    """
    page.evaluate(
        """() => new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
        })"""
    )


def _xterm_theme(page) -> dict:
    """Read the palette the live xterm instance is actually configured with.

    Args:
        page: The Playwright page.

    Returns:
        The ``term.options.theme`` object - the palette AFTER the opacity
        adapter, which is the last thing between a manifest and the renderer.
    """
    return page.evaluate(
        "() => JSON.parse(JSON.stringify(window.TerminalController.term.options.theme))"
    )


def _write_blocks(page, cells: list[dict]) -> None:
    """Fill the first row with FULL BLOCK glyphs in given ANSI colours.

    A full block fills its whole cell, so the centre of the cell is the pure
    foreground colour with no antialiasing blend. Writing a letter instead and
    sampling near it reads a mixture of foreground and background, which
    matches no palette entry and produces a test that fails for the wrong
    reason.

    Args:
        page: The Playwright page.
        cells: One dict per cell, each with an ``sgr`` string (the SGR
            parameter, e.g. "36" for cyan, "39" for the default foreground).
    """
    sequence = "".join(f"[{cell['sgr']}m█" for cell in cells) + "[0m"
    page.evaluate(
        """(text) => new Promise((resolve) => {
            const term = window.TerminalController.term;
            term.reset();
            term.write(text, resolve);
        })""",
        sequence,
    )
    _settle_frames(page)


def _cell_boxes(page, count: int) -> list[dict]:
    """Compute the page coordinates of the first ``count`` cell centres.

    Derived from the rendered screen element's own geometry and the terminal's
    reported column count, so a different font metric or viewport cannot make
    the sample land on the wrong cell.

    Args:
        page: The Playwright page.
        count: How many leading cells of row 0 to locate.

    Returns:
        A list of ``{"x": int, "y": int}`` page coordinates.
    """
    return page.evaluate(
        """(count) => {
            const term = window.TerminalController.term;
            const screen = document.querySelector('#terminal .xterm-screen');
            const rect = screen.getBoundingClientRect();
            const cellWidth = rect.width / term.cols;
            const cellHeight = rect.height / term.rows;
            const out = [];
            for (let i = 0; i < count; i++) {
                out.push({
                    x: Math.round(rect.x + (i + 0.5) * cellWidth),
                    y: Math.round(rect.y + 0.5 * cellHeight),
                });
            }
            return out;
        }""",
        count,
    )


def _empty_box(page) -> dict:
    """Page coordinates of a cell well away from any written text.

    Args:
        page: The Playwright page.

    Returns:
        A ``{"x": int, "y": int}`` page coordinate inside the terminal, in a
        row nothing has been written to, so the pixel there is the background.
    """
    return page.evaluate(
        """() => {
            const term = window.TerminalController.term;
            const screen = document.querySelector('#terminal .xterm-screen');
            const rect = screen.getBoundingClientRect();
            return {
                x: Math.round(rect.x + rect.width / 2),
                y: Math.round(rect.y + (rect.height / term.rows) * (term.rows - 2)),
            };
        }"""
    )


def _sample(page, points: list[dict], save_to: Path | None = None) -> list[tuple]:
    """Sample the PNG Chromium produced at the given page coordinates.

    Args:
        page: The Playwright page.
        points: ``{"x": int, "y": int}`` page coordinates.
        save_to: Optional path to write the screenshot to, so a failure can be
            looked at rather than only read about.

    Returns:
        One (r, g, b) triple per point.
    """
    from PIL import Image  # noqa: PLC0415

    # DETERMINISTIC OPACITY BASELINE, RE-ARMED AT EVERY SAMPLE. These
    # manifests are marked `builtin`, which is what the real server marks a
    # bundled theme, and the registry deliberately bypasses the effects
    # consent prompt for those - so the animated backgrounds really do mount
    # here, and each theme change remounts one and re-publishes `running`. A
    # translucent terminal makes a sampled pixel a blend of the palette and
    # whatever the effect canvas was drawing on that frame, which is not a
    # colour any manifest contains. Declaring the effect INACTIVE selects the
    # adapter's documented full-opacity outcome through its own observer, so
    # the pixel below is the manifest colour. The translucent outcome is
    # measured in its own class, which sets `running` itself.
    _set_effect_status(page, "inactive")

    shot = page.screenshot()
    if save_to is not None:
        save_to.write_bytes(shot)
    image = Image.open(io.BytesIO(shot)).convert("RGB")
    return [image.getpixel((point["x"], point["y"])) for point in points]


def _assert_close(actual: tuple, expected_hex: str, what: str) -> None:
    """Assert a sampled pixel matches a manifest colour within tolerance.

    Args:
        actual: The sampled (r, g, b) triple.
        expected_hex: The manifest's ``#rrggbb`` value.
        what: A sentence naming what was measured, printed on failure.
    """
    expected = _hex_to_rgb(expected_hex)
    delta = max(abs(a - b) for a, b in zip(actual, expected))
    assert delta <= CHANNEL_TOLERANCE, (
        f"{what}: rendered {actual}, expected {expected} from {expected_hex} "
        f"(per-channel difference {delta} > {CHANNEL_TOLERANCE})"
    )


class TestPinnedTerminalSurvivesItsAgent:
    """The reported defect, measured in pixels off a real canvas."""

    def test_the_first_attach_paints_the_pin_not_the_agent(self, page, tmp_path):
        """Entering a snes-pinned claude session must render snes.

        This is the state the owner's first screenshot shows, and it was
        already correct before the fix. It is here so the regression check has
        a measured starting point rather than an assumed one.
        """
        _enter(page, _session_info("cloude_a", "snes", "claude"), first_time=True)
        _set_effect_status(page, "inactive")
        theme = _xterm_theme(page)
        assert theme["background"].lower() == SNES["xterm"]["background"].lower()

        pixel = _sample(page, [_empty_box(page)],
                        save_to=tmp_path / "first-attach.png")[0]
        _assert_close(pixel, SNES["xterm"]["background"],
                      "the terminal background on first attach")

    def test_leaving_and_returning_keeps_the_snes_terminal(self, page, tmp_path):
        """THE REPORTED DEFECT. Leave the session, come back, sample again.

        Before the fix this rendered the claude background (#1e1e1e) inside a
        page that was still snes, because app.js repainted the terminal with
        the agent's manifest after navigation had painted the pin.
        """
        info = _session_info("cloude_a", "snes", "claude")
        _enter(page, info, first_time=True)
        before = _sample(page, [_empty_box(page)])[0]

        page.evaluate("() => window.App.showLaunchpad()")
        _settle_frames(page)
        _enter(page, info)

        after = _sample(page, [_empty_box(page)],
                        save_to=tmp_path / "after-return.png")
        _assert_close(after[0], SNES["xterm"]["background"],
                      "the terminal background AFTER leaving and returning")
        assert max(abs(a - b) for a, b in zip(before, after[0])) <= CHANNEL_TOLERANCE, (
            f"the terminal changed colour across a leave and return: "
            f"{before} became {after[0]}"
        )
        assert page.evaluate("() => document.documentElement.dataset.theme") == "snes"
        assert page.evaluate(
            "() => document.getElementById('terminal-screen').dataset.sessionTheme"
        ) == "snes", "the agent must not take the terminal CSS scope back"

    def test_foreground_cursor_and_ansi_swatches_are_the_snes_manifest(
        self, page, tmp_path
    ):
        """Background alone is not the palette.

        A merge that fixed the background and left stale ANSI colours behind
        would pass a background-only check and still look wrong, so a
        representative spread is rendered as full blocks and sampled.
        """
        info = _session_info("cloude_a", "snes", "claude")
        _enter(page, info, first_time=True)
        page.evaluate("() => window.App.showLaunchpad()")
        _settle_frames(page)
        _enter(page, info)

        swatches = [
            ("39", "foreground"),
            ("36", "cyan"),
            ("31", "red"),
            ("32", "green"),
            ("34", "blue"),
            ("35", "magenta"),
            ("93", "brightYellow"),
        ]
        _write_blocks(page, [{"sgr": sgr} for sgr, _ in swatches])
        boxes = _cell_boxes(page, len(swatches))
        pixels = _sample(page, boxes, save_to=tmp_path / "ansi-swatches.png")

        for (sgr, key), pixel in zip(swatches, pixels):
            _assert_close(pixel, SNES["xterm"][key],
                          f"SGR {sgr} ({key}) after leaving and returning")

        # The cursor colour has no glyph to sample; it is asserted on the
        # options object, which is the value the renderer reads.
        _set_effect_status(page, "inactive")
        assert _xterm_theme(page)["cursor"].lower() == SNES["xterm"]["cursor"].lower()

    def test_an_unpinned_session_still_renders_its_agent_palette(self, page):
        """The fallback the fix must not eat.

        An unpinned session follows its agent. That behaviour predates the
        defect and is deliberate, so it is measured rather than assumed.
        """
        page.evaluate("() => localStorage.setItem('cloude.theme', 'snes')")
        page.evaluate("() => window.Themes.applyTheme('snes', {persist: true})")
        _enter(page, _session_info("cloude_b", None, "claude"), first_time=True)

        pixel = _sample(page, [_empty_box(page)])[0]
        _assert_close(pixel, CLAUDE["xterm"]["background"],
                      "an unpinned session's terminal follows its agent")
        assert page.evaluate("() => document.documentElement.dataset.theme") == "snes", (
            "while the PAGE still follows the user's global theme"
        )

    def test_a_b_a_switching_lands_back_on_snes(self, page, tmp_path):
        """Rapid switching between differently themed sessions."""
        a = _session_info("cloude_a", "snes", "claude")
        b = _session_info("cloude_b", "matrix", "claude")
        _enter(page, a, first_time=True)
        _enter(page, b)
        _enter(page, a)

        pixel = _sample(page, [_empty_box(page)], save_to=tmp_path / "aba.png")[0]
        _assert_close(pixel, SNES["xterm"]["background"], "back on session A")

    def test_the_scoped_css_variables_follow_the_new_owner(self, page):
        """No variable from the outgoing theme may be left on the screen.

        The inline custom properties on ``#terminal-screen`` are what the
        per-theme CSS blocks read. A stale one is invisible to a palette check
        and visible to a human.
        """
        _enter(page, _session_info("cloude_b", "matrix", "claude"), first_time=True)
        _enter(page, _session_info("cloude_a", "snes", "claude"))

        matrix_only = [
            name for name in MANIFESTS["matrix"].get("cssVars", {})
            if name not in SNES.get("cssVars", {})
        ]
        leaked = page.evaluate(
            """(names) => {
                const el = document.getElementById('terminal-screen');
                return names.filter((n) => el.style.getPropertyValue(n) !== '');
            }""",
            matrix_only,
        )
        assert leaked == [], f"variables from the outgoing theme survived: {leaked}"

        sample_name = next(iter(SNES.get("cssVars", {})), None)
        if sample_name is not None:
            value = page.evaluate(
                "(n) => document.getElementById('terminal-screen')"
                ".style.getPropertyValue(n).trim()",
                sample_name,
            )
            assert value == SNES["cssVars"][sample_name].strip(), (
                f"{sample_name} did not take the incoming theme's value"
            )


class TestTheOpacityAdapterIsTheOnlyTransform:
    """Exactly one thing may sit between a manifest and the renderer."""

    def test_it_changes_the_background_and_nothing_else(self, page):
        """With an animated background confirmed on screen.

        ``client/js/terminal-background-opacity.js`` is the ONE permitted
        transform. Flipping the effect status to `running` is what turns it
        on; every other channel must come through byte-identical to the
        manifest, or a second transform has been introduced.
        """
        _enter(page, _session_info("cloude_a", "snes", "claude"), first_time=True)
        _set_effect_status(page, "running")

        theme = _xterm_theme(page)
        red, green, blue = _hex_to_rgb(SNES["xterm"]["background"])
        assert theme["background"] == f"rgba({red}, {green}, {blue}, 0.9)", (
            "the background must be the manifest colour at the adapter's "
            f"opacity, got {theme['background']}"
        )
        for key, expected in SNES["xterm"].items():
            if key == "background":
                continue
            assert theme[key].lower() == expected.lower(), (
                f"{key} was altered on its way to the renderer; the opacity "
                "adapter must only touch the background"
            )

    def test_an_inactive_effect_leaves_the_terminal_fully_opaque(self, page):
        """The three-outcome rule: never translucent over nothing."""
        _enter(page, _session_info("cloude_a", "snes", "claude"), first_time=True)
        _set_effect_status(page, "inactive")

        theme = _xterm_theme(page)
        assert theme["background"].lower() == SNES["xterm"]["background"].lower(), (
            "with no animated background confirmed on screen the terminal "
            "must render at full opacity"
        )
