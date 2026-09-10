"""The session row's three-dot ACTION MENU, measured in a real browser.

Its sibling ``tests/test_session_row_menu.node.mjs`` pins the DEFINITION:
which five items exist, which letter each one owns, that a disabled item
carries its reason as text, and that a row's identity survives the round
trip into the trigger's attributes. None of that needs a browser.

EVERYTHING BELOW DOES, and for reasons that are not interchangeable:

* focus order is a property of the live document, not of a markup string;
* a key guard only proves anything when a real KeyboardEvent carrying
  ``ctrlKey``, ``repeat`` or ``isComposing`` is dispatched at it, and when
  a listener BELOW the menu is watching to see whether the key got
  through;
* "the panel is fully on screen" is arithmetic over measured boxes, and
  "it scrolls itself" is a comparison of ``scrollHeight`` against
  ``clientHeight`` that only exists once something has laid out;
* the panel is ``position: fixed`` and mounted on the body precisely
  because the sidebar is ``transform``ed, and no DOM assertion can tell
  you which box it was actually placed against;
* and CAPTURED IDENTITY is only interesting once a repaint has actually
  destroyed and rebuilt the row underneath an open menu.

THE TRAPS AVOIDED ON PURPOSE

* Every measurement asserts ``document.hidden is False`` first. A
  backgrounded tab freezes rAF and leaves transitions at currentTime 0,
  which manufactures a false result inside the verification step.
* Presence is never accepted as rendering: the decisive checks are
  ``getBoundingClientRect``, ``getComputedStyle``, ``document.activeElement``
  and a scroll-height comparison.
* Nothing re-runs an init to see whether it ran. The open module wires
  its document listener once, at load, and is never re-loaded here.
* The negative controls are the load-bearing ones. A key handler that
  swallowed everything would pass every positive test in this file.

SCREENSHOTS. Set ``CLOUDE_MENU_SHOTS=<dir>`` to have the screenshot test
write its images somewhere durable; with the variable unset it writes to
pytest's own tmp directory and the images are still produced, still
compared for size, and simply not kept.

If Playwright or its Chromium is unavailable these tests SKIP, and the
skip says the rendering was NOT measured. A skip is the third outcome; it
is not a pass.
"""

from __future__ import annotations

import http.server
import json
import os
import socket
import socketserver
import threading
from pathlib import Path

import pytest

pytest.importorskip(
    "playwright.sync_api",
    reason=(
        "playwright is not installed, so NOTHING about how the session row "
        "action menu renders or behaves was measured. This is a "
        "could-not-evaluate, not a pass."
    ),
)

REPO_ROOT = Path(__file__).resolve().parent.parent
CLIENT_ROOT = REPO_ROOT / "client"
THEME_ROOT = CLIENT_ROOT / "css" / "themes"

#: A desktop window, and the phone width the owner's own sidebar squeezes
#: to. Both are asserted against, not just screenshotted.
DESKTOP = {"width": 1280, "height": 860}
NARROW = {"width": 330, "height": 720}

#: Short enough that a five-item menu cannot fit, so the internal scroll
#: is the only way the last item is reachable.
SHORT = {"width": 900, "height": 180}

#: Stylesheets the row and its menu cascade through, in the order
#: client/index.html loads them. Order is load bearing: session-row-menu.css
#: re-styles elements the density and inline-control files have already
#: sized as small square icon buttons.
CSS_FILES = [
    "css/styles.css",
    "css/session-sidebar.css",
    "css/session-sidebar-density.css",
    "css/session-sidebar-groups.css",
    "css/session-row-inline-controls.css",
    "css/session-row-menu.css",
]

#: The REAL modules. Nothing in the chain from a row payload to an open,
#: focused, keyboard-driven menu is stubbed; only the collaborators
#: beyond it are.
JS_FILES = [
    "js/kebab-icon.js",
    "js/session-status-ui.js",
    "js/session-row-actions.js",
    "js/session-label.js",
    "js/session-theme-tint.js",
    "js/anchor-popover.js",
    "js/session-row-menu.js",
    "js/session-row-menu-actions.js",
    "js/session-row-menu-open.js",
    "js/session-sidebar-rows.js",
    "js/session-sidebar-clicks.js",
]

HARNESS_HTML = """<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
__CSS__
<style>
  :root { __TOKENS__ }
  html, body { margin: 0; background: var(--color-bg); color: var(--color-fg); }
  /* The sidebar OPEN, because that is the only state a row is visible in.
     .session-sidebar-panel keeps its own transform from the real
     stylesheet; the open class is what cancels it. */
  #session-sidebar-list { overflow-y: auto; max-height: 60vh; }
  /* A stand-in for the terminal that sits under everything. It records
     any keystroke that reaches it, which is how "a handled key never
     reaches the terminal" is measured rather than asserted. */
  #terminal-proxy { position: fixed; inset: auto 0 0 0; height: 40px; }
</style>
</head>
<body>
<aside id="session-sidebar-panel"
       class="session-sidebar-panel session-sidebar-panel--open"
       data-density="cozy">
  <div id="session-sidebar-list" class="session-sidebar-list" role="listbox"></div>
  <div id="session-sidebar-live" class="session-sidebar-live"></div>
</aside>
<div id="terminal-proxy" tabindex="0"></div>
<input id="outside-field" type="text" />
__JS__
<script>
/* Collaborators BEYOND the chain under test. Every one records instead of
   acting, so an assertion can say which handler an item reached. */
window.__calls = [];
window.__keysReachingTerminal = [];
function rec(name) {
  return function () {
    window.__calls.push([name].concat(Array.prototype.slice.call(arguments)));
    return Promise.resolve({ ok: true });
  };
}
window.__records = [
  {session_uuid: 'uuid-a', tmux_name: 'row-a', working_dir: '/tmp/row-a',
   title: 'Alpha', tmux_created_epoch: 10, archived_at: null},
  {session_uuid: 'uuid-b', tmux_name: 'row-b', working_dir: '/tmp/row-b',
   title: 'Beta', tmux_created_epoch: 20, archived_at: null},
];
window.__muteFails = false;
window.API = {
  destroySession: rec('destroySession'),
  destroyExternalSession: rec('destroyExternalSession'),
  getSession: rec('getSession'),
  adoptSession: rec('activateRow'),
  respawnSession: rec('respawnSession'),
  forkSession: function (name) {
    window.__calls.push(['forkSession', name]);
    return Promise.resolve({
      success: true, lineage_recorded: true,
      session: {id: 'ses_child', tmux_session: name + '_fork'},
    });
  },
  listSessionRecords: function () {
    window.__calls.push(['listSessionRecords']);
    return Promise.resolve(window.__records);
  },
  call: function (path, opts) {
    window.__calls.push(['call', path, opts && opts.method,
      opts && opts.body ? opts.body.muted : null]);
    if (window.__muteFails) return Promise.reject(new Error('server said no'));
    return Promise.resolve({
      muted: !!(opts && opts.body && opts.body.muted), policy_generation: 3});
  },
};
window.App = {
  showConfirmModal: function (title) {
    window.__calls.push(['confirm', title]);
    return Promise.resolve(true);
  },
  returnToExistingTerminal: rec('returnToExistingTerminal'),
};
window.SessionSidebarRename = {
  beginEdit: function (rowEl) {
    window.__calls.push(['beginEdit', rowEl && rowEl.getAttribute('data-name')]);
    return true;
  },
};
window.Launchpad = {
  showError: function (text) { window.__calls.push(['showError', text]); },
  selectProject: function (p) {
    window.__calls.push(['selectProject', p.name, p.path]);
    return Promise.resolve();
  },
  _handleSessionRowAction: rec('_handleSessionRowAction'),
  _handleRenameRunningSession: rec('_handleRenameRunningSession'),
};
window.SessionSidebar = {
  _lastSig: null,
  _activeTmuxName: null,
  _closeAfterSwitch: function () {},
  close: function () {},
  repaint: function () { window.__calls.push(['repaint']); },
  _fetchAndRender: function () { return Promise.resolve(); },
};
window.addEventListener('session-created', function (e) {
  window.__calls.push(['opened', e.detail && e.detail.session
    && e.detail.session.tmux_session]);
});

/* The list's own click router, wired exactly as client/js/session-sidebar.js
   wires it: the REAL onRowClick, in the bubble phase, on the list. The
   menu's trigger click has to beat this. */
var list = document.getElementById('session-sidebar-list');
list.addEventListener('click', function (e) {
  window.SessionSidebarClicks.onRowClick(window.SessionSidebar, e);
});

/* The terminal proxy records every key that reaches the document's
   BUBBLE phase, which is where a terminal's own handler would sit. */
document.addEventListener('keydown', function (e) {
  window.__keysReachingTerminal.push(e.key);
});

/* Paint rows from real payloads through the real builder. */
window.__rows = [];
window.__paint = function (rows) {
  if (rows) window.__rows = rows;
  list.innerHTML = window.__rows.map(function (r) {
    return window.SessionSidebarRows.rowHtml(r, 'cozy');
  }).join('');
};
</script>
</body>
</html>
"""

ROWS = [
    {"name": "row-a", "label": "Alpha", "status": "working",
     "created_by_cloude": True, "is_this_tab": False, "unread": False,
     "is_pinned": False, "session_id": "ses_a", "notifications_muted": False},
    {"name": "row-b", "label": "Beta", "status": "idle",
     "created_by_cloude": True, "is_this_tab": False, "unread": True,
     "is_pinned": True, "session_id": "ses_b", "notifications_muted": True},
    {"name": "row-ext", "label": "Outsider", "status": "idle",
     "created_by_cloude": False, "is_this_tab": False, "unread": False,
     "is_pinned": False, "session_id": None},
    {"name": "row-dead", "label": "Stopped", "status": "dead",
     "created_by_cloude": False, "is_this_tab": False, "unread": False,
     "is_pinned": False, "session_id": None},
]


def _theme_tokens(theme_id: str) -> str:
    """Read one shipped theme's CSS variables as a declaration block.

    Taking the real theme's values rather than inventing a palette is
    what makes a screenshot evidence about the app instead of about the
    harness.

    Args:
        theme_id: a directory name under ``client/css/themes``.

    Returns:
        str: ``--name: value;`` declarations, ready for a ``:root`` block.
    """
    data = json.loads((THEME_ROOT / theme_id / "theme.json").read_text())
    return " ".join(f"{k}: {v};" for k, v in data["cssVars"].items())


def _luminance(value: str) -> float | None:
    """Perceived luminance of a ``#rgb`` / ``#rrggbb`` colour, 0-255.

    Args:
        value: a CSS hex colour.

    Returns:
        float | None: the luminance, or None when the value is not hex.
    """
    text = value.strip().lstrip("#")
    if len(text) == 3:
        text = "".join(c * 2 for c in text)
    if len(text) != 6:
        return None
    try:
        r, g, b = (int(text[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _light_themes() -> list[str]:
    """Every shipped theme whose own background is light.

    Derived from the themes on disk rather than hardcoded, so a theme
    added or removed later changes what is measured instead of quietly
    going uncovered.

    Returns:
        list[str]: theme ids, sorted.
    """
    out = []
    for path in sorted(THEME_ROOT.glob("*/theme.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        lum = _luminance(str(data.get("cssVars", {}).get("--color-bg", "")))
        if lum is not None and lum > 128:
            out.append(path.parent.name)
    return out


def _free_port() -> int:
    """Grab a port the OS says is free.

    Returns:
        int: a TCP port on 127.0.0.1 nothing is listening on.
    """
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _harness_html(theme_id: str = "claude") -> str:
    """Build the harness page with the real assets linked in.

    Args:
        theme_id: which shipped theme's variables to declare on ``:root``.

    Returns:
        str: complete HTML, CSS and JS referenced by URL so the browser
            fetches the shipped files rather than an inlined copy.
    """
    css = "\n".join(
        f'<link rel="stylesheet" href="/static/{name}">' for name in CSS_FILES
    )
    js = "\n".join(f'<script src="/static/{name}"></script>' for name in JS_FILES)
    return (HARNESS_HTML
            .replace("__CSS__", css)
            .replace("__JS__", js)
            .replace("__TOKENS__", _theme_tokens(theme_id)))


class _ClientHandler(http.server.SimpleHTTPRequestHandler):
    """Serve ``client/`` under ``/static/`` and the harness at ``/``.

    The real app mounts the client at ``/static``, and every path inside
    the shipped CSS and JS is written against that prefix.
    """

    def translate_path(self, path: str) -> str:  # noqa: D102 - base class docs
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/static/"):
            return str(CLIENT_ROOT / clean[len("/static/"):])
        return str(CLIENT_ROOT / clean.lstrip("/"))

    def do_GET(self) -> None:  # noqa: N802 - http.server's spelling
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html") or path.startswith("/theme/"):
            theme = path[len("/theme/"):] if path.startswith("/theme/") else "claude"
            body = _harness_html(theme or "claude").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *args) -> None:  # noqa: D102 - silence the test run
        return


@pytest.fixture(scope="module")
def base_url() -> str:
    """Serve ``client/`` for the duration of the module.

    Yields:
        str: ``http://127.0.0.1:<port>``.
    """
    port = _free_port()
    server = socketserver.ThreadingTCPServer(("127.0.0.1", port), _ClientHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()
        server.server_close()


def _open_page(pw, base_url, viewport, path="/", touch=False):
    """A Chromium page with the rows already painted.

    Args:
        pw: the sync_playwright driver.
        base_url: the harness origin.
        viewport: a ``{width, height}`` dict.
        path: harness path, which selects the theme.
        touch: emulate a coarse pointer.

    Returns:
        tuple: ``(browser, context, page)`` - the caller closes them.
    """
    try:
        browser = pw.chromium.launch()
    except Exception as exc:  # noqa: BLE001 - reported, not swallowed
        pytest.skip(
            f"chromium could not launch ({exc}), so NOTHING about how the row "
            "action menu renders was measured. Not a pass."
        )
    context = browser.new_context(
        viewport=viewport, is_mobile=touch, has_touch=touch,
        device_scale_factor=1,
    )
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base_url + path, wait_until="load")
    assert page.evaluate("document.hidden") is False, (
        "the page reports document.hidden; a backgrounded tab freezes its "
        "render loop and every measurement below would be manufactured"
    )
    assert page.evaluate("!!window.SessionRowMenu"), "session-row-menu.js did not load"
    assert page.evaluate("!!window.SessionRowMenuOpen"), (
        "session-row-menu-open.js did not load, so no menu can open"
    )
    page.evaluate("rows => window.__paint(rows)", ROWS)
    assert not errors, f"the page threw while loading: {errors}"
    return browser, context, page


@pytest.fixture()
def page(base_url):
    """A desktop page with the rows painted.

    Yields:
        Page: ready to drive.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser, context, pg = _open_page(pw, base_url, DESKTOP)
        try:
            yield pg
        finally:
            context.close()
            browser.close()


def _trigger(page, name: str):
    """Locator for one row's menu trigger.

    Args:
        page: the Playwright page.
        name: the row's tmux name.

    Returns:
        Locator: that row's three-dot button.
    """
    return page.locator(f'.session-sidebar-row[data-name="{name}"] [data-row-menu]')


def _items(page):
    """Locator for the open panel's items, in render order.

    Args:
        page: the Playwright page.

    Returns:
        Locator: every ``[role=menuitem]`` in the panel.
    """
    return page.locator('#session-row-menu-panel [role="menuitem"]')


def _focused_item(page) -> str | None:
    """Which item id currently holds focus, or None.

    Args:
        page: the Playwright page.

    Returns:
        str | None: the focused item's id.
    """
    return page.evaluate(
        "() => { const a = document.activeElement; return a && a.getAttribute "
        "? a.getAttribute('data-row-menu-item') : null; }"
    )


# ---------------------------------------------------------------------
# Opening, and what is in the panel
# ---------------------------------------------------------------------

def test_the_menu_opens_on_the_trigger_and_holds_the_five_items(page):
    """It opens, it holds five items, and it opens nothing else."""
    assert page.locator("#session-row-menu-panel").count() == 0
    _trigger(page, "row-a").click()
    assert page.locator("#session-row-menu-panel").count() == 1
    ids = page.evaluate(
        "() => Array.from(document.querySelectorAll("
        "'#session-row-menu-panel [role=\"menuitem\"]'),"
        " (b) => b.getAttribute('data-row-menu-item'))"
    )
    assert ids == ["rename", "fork", "new-in-folder", "mute", "close"]
    assert _trigger(page, "row-a").get_attribute("aria-expanded") == "true"


def test_opening_the_menu_does_not_also_open_the_conversation(page):
    """The trigger sits inside the row, whose click means "switch to this".

    The capture-phase claim is what stops one press doing both, and only
    a browser delivers the real event order that makes it matter.
    """
    page.evaluate("window.__calls = []")
    _trigger(page, "row-a").click()
    page.wait_for_timeout(80)
    calls = page.evaluate("window.__calls")
    assert not any(c[0] in ("activateRow", "getSession", "returnToExistingTerminal")
                   for c in calls), (
        f"pressing the trigger also tried to open the conversation: {calls}"
    )


def test_the_shortcut_letters_render_right_aligned_and_muted(page):
    """A hint about the keyboard, not part of the label.

    Measured as geometry and computed colour: the letters must share a
    right edge with each other and be dimmer than the label beside them.
    """
    _trigger(page, "row-a").click()
    metrics = page.evaluate(
        """() => {
            const panel = document.getElementById('session-row-menu-panel');
            const rows = Array.from(panel.querySelectorAll('[role="menuitem"]'));
            return rows.map((r) => {
                const key = r.querySelector('.session-row-menu__key');
                const label = r.querySelector('.session-row-menu__label');
                return {
                    text: key.textContent,
                    right: key.getBoundingClientRect().right,
                    keyColor: getComputedStyle(key).color,
                    labelColor: getComputedStyle(label).color,
                    labelRight: label.getBoundingClientRect().right,
                };
            });
        }"""
    )
    assert [m["text"] for m in metrics] == ["R", "F", "N", "M", "C"]
    rights = [round(m["right"], 1) for m in metrics]
    assert max(rights) - min(rights) <= 1, (
        f"the shortcut letters do not share a right edge: {rights}"
    )
    for m in metrics:
        assert m["labelRight"] <= m["right"] + 1, "the label runs past its letter"
        assert m["keyColor"] != m["labelColor"], (
            "the shortcut letter is the same colour as the label, so it reads "
            "as part of the label rather than as a hint"
        )


def test_close_sits_below_a_separator_that_actually_paints(page):
    """A rule with no height is a rule nobody can see."""
    _trigger(page, "row-a").click()
    box = page.evaluate(
        """() => {
            const sep = document.querySelector(
                '#session-row-menu-panel .session-row-menu__sep');
            if (!sep) return null;
            const r = sep.getBoundingClientRect();
            const close = document.querySelector(
                '#session-row-menu-panel [data-row-menu-item="close"]'
            ).getBoundingClientRect();
            const mute = document.querySelector(
                '#session-row-menu-panel [data-row-menu-item="mute"]'
            ).getBoundingClientRect();
            return {height: r.height, width: r.width, top: r.top,
                    closeTop: close.top, muteBottom: mute.bottom,
                    bg: getComputedStyle(sep).backgroundColor};
        }"""
    )
    assert box is not None, "no separator was rendered"
    assert box["height"] >= 1 and box["width"] > 0, "the separator has no box"
    assert box["bg"] not in ("rgba(0, 0, 0, 0)", "transparent"), (
        "the separator is transparent, so the destructive item does not look "
        "set apart from the four that are not"
    )
    assert box["muteBottom"] <= box["top"] + 1 <= box["closeTop"] + 1, (
        "the separator is not between mute and close"
    )


# ---------------------------------------------------------------------
# Focus and the keyboard
# ---------------------------------------------------------------------

def test_focus_lands_on_the_first_item_and_the_arrows_walk_it(page):
    """Roving focus, wrapping at both ends, including Home and End."""
    _trigger(page, "row-a").click()
    assert _focused_item(page) == "rename", "focus did not land on the first item"
    page.keyboard.press("ArrowDown")
    assert _focused_item(page) == "fork"
    page.keyboard.press("ArrowUp")
    assert _focused_item(page) == "rename"
    page.keyboard.press("ArrowUp")
    assert _focused_item(page) == "close", "ArrowUp from the first item must wrap"
    page.keyboard.press("ArrowDown")
    assert _focused_item(page) == "rename", "ArrowDown from the last must wrap"
    page.keyboard.press("End")
    assert _focused_item(page) == "close"
    page.keyboard.press("Home")
    assert _focused_item(page) == "rename"


def test_every_shortcut_letter_runs_its_own_item(page):
    """Each of the five, pressed, reaching the handler that item names."""
    cases = [
        ("r", "row-a", lambda calls: ["beginEdit", "row-a"] in calls),
        ("f", "row-a", lambda calls: ["forkSession", "row-a"] in calls),
        ("n", "row-a", lambda calls: any(
            c[0] == "selectProject" and c[2] == "/tmp/row-a" for c in calls)),
        ("m", "row-a", lambda calls: any(
            c[0] == "call" and c[1].endswith("/notifications") for c in calls)),
        ("c", "row-a", lambda calls: any(c[0] == "confirm" for c in calls)),
    ]
    for key, row, check in cases:
        page.evaluate("window.__calls = []")
        _trigger(page, row).click()
        page.keyboard.press(key)
        page.wait_for_timeout(250)
        calls = page.evaluate("window.__calls")
        assert check(calls), f"pressing {key} did not run its item: {calls}"
        assert page.locator("#session-row-menu-panel").count() == 0, (
            f"the menu stayed open after {key} ran"
        )
        page.evaluate("window.__paint()")


def test_enter_and_space_activate_the_focused_item(page):
    """Both, because a menu item is a button and both are its keys."""
    for key in ("Enter", " "):
        page.evaluate("window.__calls = []")
        _trigger(page, "row-a").click()
        page.keyboard.press("ArrowDown")   # fork
        page.keyboard.press(key)
        page.wait_for_timeout(200)
        calls = page.evaluate("window.__calls")
        assert ["forkSession", "row-a"] in calls, (
            f"{key!r} on the focused item did not run it: {calls}"
        )
        page.evaluate("window.__paint()")


def test_a_handled_key_never_reaches_the_terminal(page):
    """The negative control, and the reason the listener is in capture.

    A letter that ran a menu item and ALSO reached the document's bubble
    phase would have been typed into the running agent.
    """
    page.evaluate("window.__keysReachingTerminal = []")
    _trigger(page, "row-a").click()
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Escape")
    page.wait_for_timeout(80)
    leaked = page.evaluate("window.__keysReachingTerminal")
    assert leaked == [], f"these keys reached the terminal anyway: {leaked}"


def test_a_modified_key_is_not_ours_and_is_left_alone(page):
    """Ctrl+R must not rename, and must not be swallowed either.

    Swallowing it would break reload, copy and paste for as long as a
    menu happened to be open, which is a worse bug than the one the
    shortcut solves.
    """
    page.evaluate("window.__calls = []; window.__keysReachingTerminal = []")
    _trigger(page, "row-a").click()
    page.keyboard.press("Control+r")
    page.wait_for_timeout(120)
    calls = page.evaluate("window.__calls")
    assert not any(c[0] == "beginEdit" for c in calls), (
        f"Ctrl+R ran the rename item: {calls}"
    )
    assert "r" in page.evaluate("window.__keysReachingTerminal"), (
        "Ctrl+R was swallowed by the menu, which breaks the browser's own key"
    )
    assert page.locator("#session-row-menu-panel").count() == 1, (
        "a modified key closed the menu"
    )


def test_an_autorepeat_press_runs_the_item_once(page):
    """A held key must not fire an action per repeat tick."""
    page.evaluate("window.__calls = []")
    _trigger(page, "row-a").click()
    page.evaluate(
        """() => document.dispatchEvent(new KeyboardEvent(
            'keydown', {key: 'f', repeat: true, bubbles: true}))"""
    )
    page.wait_for_timeout(150)
    assert not any(c[0] == "forkSession" for c in page.evaluate("window.__calls")), (
        "an autorepeat press ran the item"
    )
    assert page.locator("#session-row-menu-panel").count() == 1


def test_a_composing_keystroke_is_not_a_letter_yet(page):
    """Mid-IME composition, on both engines' spellings."""
    for extra in ({"isComposing": True}, {"keyCode": 229}):
        page.evaluate("window.__calls = []")
        if page.locator("#session-row-menu-panel").count() == 0:
            _trigger(page, "row-a").click()
        page.evaluate(
            """(extra) => document.dispatchEvent(new KeyboardEvent(
                'keydown', Object.assign(
                    {key: 'f', bubbles: true}, extra)))""",
            extra,
        )
        page.wait_for_timeout(120)
        assert not any(c[0] == "forkSession"
                       for c in page.evaluate("window.__calls")), (
            f"a composing keystroke ({extra}) ran the item"
        )


def test_a_letter_typed_into_a_field_reaches_the_field(page):
    """The rename editor this menu opens must keep every character."""
    page.evaluate("window.__calls = []")
    _trigger(page, "row-a").click()
    page.evaluate("document.getElementById('outside-field').focus()")
    page.keyboard.type("fr")
    page.wait_for_timeout(120)
    calls = page.evaluate("window.__calls")
    assert not any(c[0] in ("forkSession", "beginEdit") for c in calls), (
        f"typing into a field ran menu items: {calls}"
    )
    assert page.evaluate("document.getElementById('outside-field').value") == "fr"


# ---------------------------------------------------------------------
# Closing, and where focus ends up
# ---------------------------------------------------------------------

def test_escape_closes_and_puts_focus_back_on_the_trigger(page):
    """The one path that DOES restore focus."""
    _trigger(page, "row-a").click()
    page.keyboard.press("Escape")
    assert page.locator("#session-row-menu-panel").count() == 0
    assert page.evaluate(
        "() => document.activeElement.getAttribute('data-row-menu')") == "row-a"
    assert _trigger(page, "row-a").get_attribute("aria-expanded") == "false"


def test_tab_closes_the_menu_and_leaves_focus_where_tab_sent_it(page):
    """Tab belongs to the browser; the menu gets out of the way."""
    _trigger(page, "row-a").click()
    page.keyboard.press("Tab")
    page.wait_for_timeout(60)
    assert page.locator("#session-row-menu-panel").count() == 0
    assert page.evaluate(
        "() => document.activeElement.getAttribute('data-row-menu')") != "row-a", (
        "Tab dragged focus back to the trigger, undoing the move that "
        "dismissed the menu"
    )


def test_a_click_outside_closes_without_stealing_the_click_s_destination(page):
    """The clicked thing is where the user should end up."""
    _trigger(page, "row-a").click()
    page.locator("#outside-field").click()
    page.wait_for_timeout(80)
    assert page.locator("#session-row-menu-panel").count() == 0
    assert page.evaluate("() => document.activeElement.id") == "outside-field", (
        "closing on an outside click yanked focus off what was clicked"
    )


def test_pressing_the_same_trigger_twice_closes_the_menu(page):
    """Rebuilding it in place would look like nothing happened."""
    _trigger(page, "row-a").click()
    assert page.locator("#session-row-menu-panel").count() == 1
    _trigger(page, "row-a").click()
    assert page.locator("#session-row-menu-panel").count() == 0


# ---------------------------------------------------------------------
# Unavailable items
# ---------------------------------------------------------------------

def test_an_unavailable_item_is_focusable_explained_and_inert(page):
    """All three, because dropping any one of them is its own bug."""
    _trigger(page, "row-ext").click()
    fork = page.locator('#session-row-menu-panel [data-row-menu-item="fork"]')
    assert fork.get_attribute("aria-disabled") == "true"
    assert fork.get_attribute("tabindex") == "0", (
        "an unavailable item that cannot take focus hides its own explanation "
        "from exactly the users who need it"
    )
    # THE REASON IS ON SCREEN, not only in a tooltip.
    reason = page.locator(
        '#session-row-menu-panel [data-row-menu-item="fork"] '
        '.session-row-menu__reason'
    )
    assert reason.count() == 1
    assert reason.is_visible()
    assert len(reason.inner_text().strip()) > 10, "the refusal is not a sentence"
    described_by = fork.get_attribute("aria-describedby")
    assert described_by, "the reason is not wired to the item for a screen reader"
    assert page.evaluate(
        "(id) => !!document.getElementById(id)", described_by), (
        "aria-describedby points at an element that does not exist"
    )
    # FOCUSABLE: End walks onto it and past it, so it is in the order.
    page.keyboard.press("ArrowDown")
    assert _focused_item(page) == "fork"
    # INERT: activating it runs nothing and leaves the menu open, so the
    # explanation the user just asked for is still on screen.
    page.evaluate("window.__calls = []")
    page.keyboard.press("Enter")
    page.wait_for_timeout(150)
    assert not any(c[0] == "forkSession" for c in page.evaluate("window.__calls"))
    assert page.locator("#session-row-menu-panel").count() == 1, (
        "the menu closed on a refused activation, hiding the reason"
    )
    assert "fork" in page.evaluate(
        "() => document.getElementById('session-sidebar-live').textContent"), (
        "a refusal must be announced, not silently do nothing"
    )


def test_a_dead_row_offers_no_menu_at_all(page):
    """It keeps restart and remove, inline, exactly as before."""
    assert _trigger(page, "row-dead").count() == 0
    for action in ("restart", "remove"):
        assert page.locator(
            '.session-sidebar-row[data-name="row-dead"] '
            f'[data-session-action="{action}"]').count() == 1


# ---------------------------------------------------------------------
# Captured identity
# ---------------------------------------------------------------------

def test_a_repaint_under_an_open_menu_cannot_redirect_an_action(page):
    """The whole reason identity is frozen at paint time.

    The list is rebuilt from a DIFFERENT payload while the menu is open -
    row-a is gone and row-b now sits where it did - and the item must
    still act on row-a.
    """
    page.evaluate("window.__calls = []")
    _trigger(page, "row-a").click()
    page.evaluate(
        """() => window.__paint([
            {name: 'row-b', label: 'Beta', status: 'idle',
             created_by_cloude: true, is_this_tab: false, unread: false,
             is_pinned: false, session_id: 'ses_b'},
        ])"""
    )
    assert page.locator('.session-sidebar-row[data-name="row-a"]').count() == 0, (
        "the repaint did not actually destroy the row, so nothing was tested"
    )
    page.keyboard.press("f")
    page.wait_for_timeout(250)
    calls = page.evaluate("window.__calls")
    assert ["forkSession", "row-a"] in calls, (
        f"the fork was aimed at whatever replaced the row: {calls}"
    )
    page.evaluate("rows => window.__paint(rows)", ROWS)


def test_a_fork_that_finishes_after_a_navigation_is_not_opened(page):
    """Created, kept, and not switched to - and the user is told."""
    page.evaluate("window.__calls = []")
    _trigger(page, "row-a").click()
    # Bump the navigation token the moment the item is chosen, before the
    # fork resolves, exactly as arriving in another session would.
    page.evaluate(
        """() => {
            const orig = window.API.forkSession;
            window.API.forkSession = function (name) {
                window.dispatchEvent(new CustomEvent('session-created', {
                    detail: {session: {tmux_session: 'somewhere-else'}}}));
                return orig(name);
            };
        }"""
    )
    page.keyboard.press("f")
    page.wait_for_timeout(300)
    calls = page.evaluate("window.__calls")
    assert ["forkSession", "row-a"] in calls, "the fork was not created"
    assert ["opened", "row-a_fork"] not in calls, (
        "the fork was opened even though the user had moved on"
    )
    assert any(c[0] == "showError" and "created" in c[1] for c in calls), (
        f"the user was not told where the fork went: {calls}"
    )


# ---------------------------------------------------------------------
# Mute
# ---------------------------------------------------------------------

def test_the_mute_item_names_what_the_press_will_do(page):
    """Two rows, two states, two labels, from the row's own payload."""
    _trigger(page, "row-a").click()
    assert page.locator(
        '#session-row-menu-panel [data-row-menu-item="mute"] '
        '.session-row-menu__label').inner_text().strip() == "mute notifications"
    page.keyboard.press("Escape")
    _trigger(page, "row-b").click()
    assert page.locator(
        '#session-row-menu-panel [data-row-menu-item="mute"] '
        '.session-row-menu__label').inner_text().strip() == "unmute notifications"
    page.keyboard.press("Escape")


def test_muting_writes_the_contract_s_request_and_flips_the_label(page):
    """The endpoint, the method, the body - and the label afterwards."""
    page.evaluate("window.__calls = []; window.__muteFails = false")
    _trigger(page, "row-a").click()
    page.keyboard.press("m")
    page.wait_for_timeout(300)
    calls = page.evaluate("window.__calls")
    write = [c for c in calls if c[0] == "call"]
    assert write, f"no request was made: {calls}"
    assert write[0][1] == "/sessions/records/uuid-a/notifications", (
        f"the wrong path was written: {write[0][1]}"
    )
    assert write[0][2] == "PATCH"
    assert write[0][3] is True, "the body did not carry muted: true"
    page.evaluate("window.__paint()")
    _trigger(page, "row-a").click()
    assert page.locator(
        '#session-row-menu-panel [data-row-menu-item="mute"] '
        '.session-row-menu__label').inner_text().strip() == "unmute notifications"
    page.keyboard.press("Escape")


def test_a_refused_mute_rolls_the_label_back_and_says_so(page):
    """The screen must never keep a claim the server refused."""
    page.evaluate("window.__calls = []; window.__muteFails = true")
    page.evaluate("() => window.SessionRowMenu.setMuteOverride('row-a', null)")
    page.evaluate("rows => window.__paint(rows)", ROWS)
    _trigger(page, "row-a").click()
    page.keyboard.press("m")
    page.wait_for_timeout(300)
    calls = page.evaluate("window.__calls")
    assert any(c[0] == "showError" and "nothing was changed" in c[1]
               for c in calls), f"the failure was not reported: {calls}"
    page.evaluate("window.__paint()")
    _trigger(page, "row-a").click()
    assert page.locator(
        '#session-row-menu-panel [data-row-menu-item="mute"] '
        '.session-row-menu__label').inner_text().strip() == "mute notifications", (
        "the optimistic label survived a refused write"
    )
    page.evaluate("window.__muteFails = false")


def test_a_row_with_no_muted_field_reads_as_not_muted(page):
    """The old-server case, on screen rather than in a unit."""
    page.evaluate(
        """() => window.__paint([
            {name: 'row-old', label: 'Old server', status: 'idle',
             created_by_cloude: true, is_this_tab: false, unread: false,
             is_pinned: false, session_id: 'ses_old'},
        ])"""
    )
    _trigger(page, "row-old").click()
    assert page.locator(
        '#session-row-menu-panel [data-row-menu-item="mute"] '
        '.session-row-menu__label').inner_text().strip() == "mute notifications"
    page.keyboard.press("Escape")
    page.evaluate("rows => window.__paint(rows)", ROWS)


# ---------------------------------------------------------------------
# The viewport
# ---------------------------------------------------------------------

def test_the_panel_is_fully_on_screen_at_330px(base_url):
    """A panel with an edge past the viewport is a menu with a dead item."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser, context, pg = _open_page(pw, base_url, NARROW, touch=True)
        try:
            _trigger(pg, "row-a").click()
            box = pg.locator("#session-row-menu-panel").bounding_box()
            assert box is not None
            assert box["x"] >= 0, "the panel starts off the left edge"
            assert box["x"] + box["width"] <= NARROW["width"] + 1, (
                f"the panel runs {box['x'] + box['width'] - NARROW['width']:.1f}px "
                "off the right edge at 330px"
            )
            assert box["y"] >= 0
            assert box["y"] + box["height"] <= NARROW["height"] + 1
            assert pg.evaluate(
                "() => document.documentElement.scrollWidth "
                "<= document.documentElement.clientWidth + 1"), (
                "the open menu makes the page scroll sideways"
            )
        finally:
            context.close()
            browser.close()


def test_a_short_viewport_makes_the_panel_scroll_itself(base_url):
    """The last item stays reachable rather than landing off screen."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser, context, pg = _open_page(pw, base_url, SHORT)
        try:
            _trigger(pg, "row-a").click()
            metrics = pg.evaluate(
                """() => {
                    const p = document.getElementById('session-row-menu-panel');
                    const r = p.getBoundingClientRect();
                    return {
                        scrollH: p.scrollHeight,
                        clientH: p.clientHeight,
                        overflowY: getComputedStyle(p).overflowY,
                        bottom: r.bottom,
                        vh: window.innerHeight,
                    };
                }"""
            )
            assert metrics["bottom"] <= metrics["vh"] + 1, (
                "the panel runs off the bottom of a short viewport"
            )
            assert metrics["scrollH"] > metrics["clientH"], (
                "this viewport is not short enough to force the internal "
                "scroll, so nothing about it was measured"
            )
            assert metrics["overflowY"] in ("auto", "scroll"), (
                f"the panel does not scroll itself (overflow-y: "
                f"{metrics['overflowY']}), so its last item is unreachable"
            )
            # AND THE LAST ITEM IS ACTUALLY REACHABLE, not merely present.
            pg.keyboard.press("End")
            assert _focused_item(pg) == "close"
            reached = pg.evaluate(
                """() => {
                    const el = document.querySelector(
                        '#session-row-menu-panel [data-row-menu-item="close"]');
                    const r = el.getBoundingClientRect();
                    const hit = document.elementFromPoint(
                        r.left + r.width / 2, r.top + r.height / 2);
                    return !!(hit && (hit === el || el.contains(hit)));
                }"""
            )
            assert reached, "the last item cannot be hit after scrolling to it"
        finally:
            context.close()
            browser.close()


# ---------------------------------------------------------------------
# Screenshots
# ---------------------------------------------------------------------

def test_the_menu_renders_in_every_shipped_light_theme_and_the_dark_default(
        base_url, tmp_path):
    """Open and closed, desktop and 330px, dark plus every light theme.

    THE IMAGES ARE THE DELIVERABLE, and the assertions here are what stops
    a blank or collapsed panel being filed as one: every capture must be a
    non-trivial file, and in the OPEN captures the panel must be on screen
    with a measurable box and a background distinct from the page behind
    it. A theme whose tokens failed to resolve paints the panel the same
    colour as the page, which is exactly how an invisible menu ships.
    """
    from playwright.sync_api import sync_playwright

    out = Path(os.environ.get("CLOUDE_MENU_SHOTS") or tmp_path)
    out.mkdir(parents=True, exist_ok=True)
    themes = ["claude"] + _light_themes()
    assert len(themes) >= 2, "no light themes were found to measure"

    written = []
    with sync_playwright() as pw:
        for theme in themes:
            for label, viewport in (("desktop", DESKTOP), ("330px", NARROW)):
                browser, context, pg = _open_page(
                    pw, base_url, viewport, path=f"/theme/{theme}",
                    touch=(label == "330px"))
                try:
                    shut = out / f"menu-{theme}-{label}-closed.png"
                    pg.screenshot(path=str(shut))
                    written.append(shut)
                    _trigger(pg, "row-a").click()
                    verdict = pg.evaluate(
                        """() => {
                            const p = document.getElementById(
                                'session-row-menu-panel');
                            if (!p) return null;
                            const r = p.getBoundingClientRect();
                            return {
                                w: r.width, h: r.height,
                                panelBg: getComputedStyle(p).backgroundColor,
                                bodyBg: getComputedStyle(document.body).backgroundColor,
                                items: p.querySelectorAll('[role="menuitem"]').length,
                            };
                        }"""
                    )
                    assert verdict is not None, f"{theme}/{label}: no panel opened"
                    assert verdict["items"] == 5, (
                        f"{theme}/{label}: {verdict['items']} items, not five"
                    )
                    assert verdict["w"] > 100 and verdict["h"] > 100, (
                        f"{theme}/{label}: the panel collapsed to "
                        f"{verdict['w']}x{verdict['h']}"
                    )
                    assert verdict["panelBg"] != verdict["bodyBg"], (
                        f"{theme}/{label}: the panel is the same colour as the "
                        "page behind it, so the menu is invisible in this theme"
                    )
                    openshot = out / f"menu-{theme}-{label}-open.png"
                    pg.screenshot(path=str(openshot))
                    written.append(openshot)
                finally:
                    context.close()
                    browser.close()

        # The short viewport, once, in the dark default: the internal
        # scroll is the thing being pictured.
        browser, context, pg = _open_page(pw, base_url, SHORT)
        try:
            _trigger(pg, "row-a").click()
            shot = out / "menu-claude-short-open-scrolling.png"
            pg.screenshot(path=str(shot))
            written.append(shot)
        finally:
            context.close()
            browser.close()

        # The UNAVAILABLE state, pictured, because "focusable with an
        # explanation" is a look as well as a set of attributes: the
        # reason has to be readable, not a grey smear under a grey label.
        browser, context, pg = _open_page(pw, base_url, DESKTOP)
        try:
            _trigger(pg, "row-ext").click()
            reason = pg.locator(
                '#session-row-menu-panel [data-row-menu-item="fork"] '
                '.session-row-menu__reason')
            box = reason.bounding_box()
            assert box is not None and box["height"] > 8, (
                "the refusal text has no box, so it is not on screen to read"
            )
            shot = out / "menu-claude-desktop-open-unavailable.png"
            pg.screenshot(path=str(shot))
            written.append(shot)
        finally:
            context.close()
            browser.close()

    for path in written:
        assert path.exists(), f"{path} was not written"
        assert path.stat().st_size > 2000, (
            f"{path} is {path.stat().st_size} bytes; that is a blank or "
            "failed capture, not a screenshot of a rendered menu"
        )
    print(f"\n{len(written)} screenshots written to {out}")
