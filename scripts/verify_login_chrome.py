#!/usr/bin/env python3
"""fix/login-chrome - is the login screen's chrome actually GONE, in pixels.

The user's report was "slash commands button should not be available on
the login page. menu button top right should not be shown on login
screen." Both elements were in the DOM, correctly built, correctly
classed. There was nothing a markup assertion could have caught, and
this repo has three separate documented cases of a visibly broken
feature shipping through a fully green DOM suite for exactly that
reason.

So every verdict here comes from getBoundingClientRect() plus
getComputedStyle() in a real Chromium loading the real stylesheets and
the real modules, through tests/manual/login-chrome-harness.html. An
element with `.hidden` in its class list proves nothing; an element with
a zero-area box and `display: none` is genuinely not on screen.

THREE OUTCOMES, and they exit differently:
  0  PASS  - every control measured and landed where it should
  1  FAIL  - something was measured and was wrong
  2  CANNOT DETERMINE - the measurement could not be taken at all
             (playwright missing, browser would not launch, harness never
             became ready, tab reported itself hidden). Never a pass.

The hidden-tab check is not paranoia: a backgrounded Chromium tab
freezes CSS transitions at frame zero and never fires rAF, so computed
styles read back pre-transition values forever and a passing or failing
number measured there means nothing.

playwright is not importable under this project's venv. Run it with an
interpreter that has it, e.g.
    /opt/homebrew/bin/python3 scripts/verify_login_chrome.py
"""

from __future__ import annotations

import functools
import http.server
import socketserver
import sys
import threading
from pathlib import Path

# --legacy replicates the PRE-FIX App.showAuth() hide list in the
# harness. With client/css/screen-chrome.css removed it reproduces the
# reported bug, which is how the red-before-green claim is checked
# instead of asserted.
LEGACY = "--legacy" in sys.argv

ROOT = Path(__file__).resolve().parent.parent
HARNESS = "/tests/manual/login-chrome-harness.html"

# Controls that must be invisible on the login screen and visible once
# authenticated. The two the user named are first; the rest are the same
# class of defect, found while fixing them.
AUTH_ONLY = [
    ("slash-commands-btn", "slash commands button"),
    ("header-menu-toggle", "top-right menu button (kebab)"),
    ("configEditorBtn", "file editor"),
    ("session-sidebar-toggle", "conversations toggle"),
]

# Same contract, but these two are re-parented into the header overflow
# panel by header-menu.js, so on an authenticated screen they are 0x0
# until the kebab is opened. They are measured with it open.
AUTH_ONLY_IN_MENU = [
    ("logoutBtn", "logout"),
    ("settingsBtn", "settings"),
]

# Same contract, mobile viewport only: DPad.isMobile() gates on
# innerWidth <= 768, so at desktop width the element is never created and
# there is nothing to measure. Measured on a second, genuinely 390px page.
AUTH_ONLY_MOBILE = [
    ("dpad-float-btn", "d-pad"),
]

# Present on BOTH screens. Without this the whole suite would pass on a
# header that renders nothing at all.
ALWAYS = [("appTitle", "app title")]


class _Quiet(http.server.SimpleHTTPRequestHandler):
    """Repo-root static handler, quiet."""

    def log_message(self, fmt: str, *args: object) -> None:  # noqa: D102
        return


def serve(root: Path):
    """Start a background static server rooted at the repo.

    Inputs: root (Path) - directory to serve.
    Output: (server, port) tuple.
    """
    handler = functools.partial(_Quiet, directory=str(root))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def describe(m: dict) -> str:
    """One-line rendering of a measurement, for a failure message.

    Inputs: m (dict) - one element's measurement from __chrome().
    Output: str.
    """
    if not m.get("present"):
        return "ABSENT from the DOM"
    return "%.1fx%.1f display=%s visibility=%s opacity=%s" % (
        m["w"], m["h"], m["display"], m["visibility"], m["opacity"]
    )


def compare(auth: dict, launch: dict, spec: list, failures: list,
            where: str) -> None:
    """Assert one group's visibility contract on both screens.

    Inputs: auth (dict), launch (dict) - __chrome() bundles.
            spec (list) - [(element_id, human_label), ...].
            failures (list) - accumulator of failure strings.
            where (str) - context for the message, e.g. "desktop".
    Output: None.
    """
    for eid, label in spec:
        a = auth.get(eid, {})
        b = launch.get(eid, {})
        if not a.get("present"):
            failures.append(
                "CANNOT COMPARE %s (%s, %s): absent from the DOM on the "
                "auth screen, so nothing was measured" % (eid, label, where)
            )
            continue
        if a.get("visible"):
            failures.append(
                "LEAK: %s (%s, %s) is VISIBLE on the login screen - %s"
                % (eid, label, where, describe(a))
            )
        if not b.get("present"):
            failures.append("%s (%s, %s): absent once authenticated"
                            % (eid, label, where))
        elif not b.get("visible"):
            failures.append(
                "%s (%s, %s) is NOT visible once authenticated - %s. Hiding "
                "it on the login screen must not hide it everywhere."
                % (eid, label, where, describe(b))
            )


def check(auth: dict, launch: dict, launch_menu: dict,
          m_auth: dict, m_launch: dict, failures: list) -> None:
    """Assert the whole visibility contract.

    Inputs: auth/launch/launch_menu (dict) - desktop bundles (launchpad
            with the overflow menu open for the last one).
            m_auth/m_launch (dict) - mobile bundles.
            failures (list) - accumulator.
    Output: None.
    """
    if auth.get("isAuthenticated") is not False:
        failures.append("auth screen: body.is-authenticated should be absent")
    if launch.get("isAuthenticated") is not True:
        failures.append("launchpad: body.is-authenticated should be present")

    compare(auth, launch, AUTH_ONLY, failures, "desktop")
    compare(auth, launch_menu, AUTH_ONLY_IN_MENU, failures, "overflow menu")
    compare(m_auth, m_launch, AUTH_ONLY_MOBILE, failures, "mobile 390px")

    for eid, label in ALWAYS:
        for name, bundle in (("auth", auth), ("launchpad", launch)):
            m = bundle.get(eid, {})
            if not m.get("visible"):
                failures.append(
                    "%s (%s) must stay visible on %s - %s"
                    % (eid, label, name, describe(m))
                )


def main() -> int:
    """Run the measurement. Output: process exit code (0/1/2)."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("CANNOT DETERMINE: playwright is not importable", file=sys.stderr)
        return 2

    httpd, port = serve(ROOT)
    url = "http://127.0.0.1:%d%s" % (port, HARNESS)

    def measure(page):
        """Drive one page through launchpad then auth.

        Inputs: page - a playwright Page already at the harness url.
        Output: (launch, launch_menu, auth) bundles.
        """
        page.evaluate("window.__setScreen('launchpad')")
        launch = page.evaluate("window.__chrome()")
        page.evaluate("window.__openMenu()")
        launch_menu = page.evaluate("window.__chrome()")
        page.evaluate("window.__setScreen('auth')")
        auth = page.evaluate("window.__chrome()")
        return launch, launch_menu, auth

    def open_page(browser, w, h):
        """Open the harness at a real viewport and wait for readiness.

        Inputs: browser, w (int), h (int).
        Output: page, or None if it never became ready.
        """
        page = browser.new_page(viewport={"width": w, "height": h})
        if LEGACY:
            page.add_init_script("window.__legacyShowAuth = true")
        page.goto(url)
        if page.evaluate("document.hidden"):
            return None
        # The tool's own success string is not evidence; ask the page.
        if page.evaluate("window.innerWidth") != w:
            return None
        try:
            page.wait_for_function("window.__loginChromeReady === true",
                                   timeout=15000)
        except Exception:  # noqa: BLE001
            return None
        return page

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            desktop = open_page(browser, 1280, 900)
            if desktop is None:
                print("CANNOT DETERMINE: desktop harness never became "
                      "measurable", file=sys.stderr)
                return 2
            launch, launch_menu, auth = measure(desktop)

            mobile = open_page(browser, 390, 844)
            if mobile is None:
                print("CANNOT DETERMINE: mobile harness never became "
                      "measurable", file=sys.stderr)
                return 2
            m_launch, _m_menu, m_auth = measure(mobile)
            browser.close()
    finally:
        httpd.shutdown()

    failures: list = []
    check(auth, launch, launch_menu, m_auth, m_launch, failures)

    every = AUTH_ONLY + AUTH_ONLY_IN_MENU
    print("login screen  :", ", ".join(
        "%s=%s" % (i, "VISIBLE" if auth.get(i, {}).get("visible") else "hidden")
        for i, _ in every))
    print("authenticated :", ", ".join(
        "%s=%s" % (i, "visible" if launch_menu.get(i, {}).get("visible")
                   else "HIDDEN")
        for i, _ in every))
    print("mobile 390px  :", ", ".join(
        "%s login=%s authed=%s" % (
            i,
            "VISIBLE" if m_auth.get(i, {}).get("visible") else "hidden",
            "visible" if m_launch.get(i, {}).get("visible") else "HIDDEN")
        for i, _ in AUTH_ONLY_MOBILE))

    if failures:
        print("\nFAIL")
        for f in failures:
            print("  -", f)
        return 1
    print("\nPASS: no authenticated-only chrome renders on the login screen")
    return 0


if __name__ == "__main__":
    sys.exit(main())
