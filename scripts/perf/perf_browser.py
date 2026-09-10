"""Playwright measurements against the real client, in a real Chromium.

WHY onRender, NOT onData, AND NOT A RAW WEBSOCKET MESSAGE EVENT. The plan
this harness measures against says outright: "A parser callback is not
proof of painted output; use xterm rendering evidence." Three signals are
available client-side and only one of them is proof of paint:

  - a WebSocket 'message' event fires the instant bytes arrive - before
    xterm's parser has even looked at them;
  - xterm's own 'onData' fires once the terminal PARSES a chunk, which on
    this project's shipped renderer can still precede the actual repaint;
  - 'onRender' is xterm's own paint-completion callback - it fires after
    the renderer has redrawn the rows the parser touched, which is the
    citation the plan itself makes to the Terminal API.

Every echo/switch measurement here waits for onRender AND for the
rendered text to contain the specific character or marker the interaction
was expected to produce - not merely "a render happened", which would
pass on a render of something unrelated arriving from background scroll
or a cursor blink.

See ``scripts/perf/perf_instrument.js`` for the injected instrumentation
this module drives; it must be loaded via ``Page.add_init_script`` (or
the browser-context equivalent) before ANY navigation, so it can wrap
``window.WebSocket`` before the application ever constructs one.
"""

from __future__ import annotations

import string
import time
from pathlib import Path
from typing import Optional

import pyotp
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

INSTRUMENT_JS = (Path(__file__).resolve().parent / "perf_instrument.js").read_text()

#: Distinct printable characters, cycled, so an echo test never asserts
#: the same byte twice in a row (which a stuck terminal could satisfy by
#: accident from its own previous frame).
_ECHO_ALPHABET = string.ascii_lowercase + string.digits


def click_tolerant(page, selector: str, timeout_ms: int = 5000) -> None:
    """Click, tolerating Playwright's own post-click stability retries.

    Description: several controls in this app's real UI intentionally
      remove or hide the element that was just clicked within well under
      a second - a login button once auth succeeds, a session row once a
      switch is under way. Playwright's ``click()`` auto-waits for the
      target to be "visible, enabled and stable" AFTER the click as well
      as before; measured directly against both of the controls above, a
      real click lands (the application state changes correctly) while
      Playwright's own bookkeeping keeps retrying the whole action for
      the FULL requested timeout because the target vanished. Bounding
      this wait and swallowing ONLY a timeout here is safe because every
      caller verifies the actual outcome afterward (a visible launchpad,
      a visible terminal screen) - a click that genuinely failed to do
      anything is still caught, just by that later, true signal rather
      than by this one.
      A second, independent cause observed alongside the vanishing-target
      one above: xterm's WebGL link-layer canvas can sit in the hit-test
      path over a sidebar row that is visually on top of it (measured -
      Playwright's own log: "<canvas class=\"xterm-link-layer\">... from
      #terminal-screen intercepts pointer events"), which is a stacking
      quirk of the real page, not a synthetic-vs-real distinction this
      harness should be papering over by dispatching a fake click. This
      dispatches at the target's real coordinates regardless of what
      Chromium's hit-test says is topmost there (``force=True``) for the
      same reason the timeout is swallowed: the after-the-fact
      application-state check every caller performs is the true
      correctness gate, not Playwright's own pre-click heuristic.
    Inputs: page; selector (str); timeout_ms (int) - short, since this is
      bounding Playwright's retry loop, not the application's own work.
    Output: None. Never raises for a timeout, nor for the target simply
      not being visible yet at the moment this is called (a real, timing-
      dependent gap: a control is unhidden by ``App.showTerminal()`` /
      ``showLaunchpad()`` a beat after the screen transition itself, so
      calling this the instant a previous step returns can catch it still
      hidden - ``force=True`` bypasses hit-testability but not "has no box
      at all yet"). Other errors propagate.

      THE ``#settingsBtn`` CASE THIS USED TO CITE WAS NOT THAT, AND
      SWALLOWING IT HERE IS WHAT MADE IT LOOK LIKE IT. Diagnosed
      2026-09-10: that button is re-parented into the header overflow
      dropdown by ``client/js/header-menu.js`` (``_fold()``, called
      unconditionally at every width) and the panel is built with
      ``hidden = true``, so it has no box until the kebab is opened - not
      "not yet", but "not until someone opens the menu". No wait and no
      force can reach it, which is why ``settings open`` read n/a in every
      column of the 2026-09-10 baseline while looking like a flaky timing
      gap. ``run_baseline.py`` opens ``#header-menu-toggle`` first now.
      The lesson generalises: this function turning "I could not click
      that" into a silent pass is exactly what let a WRONG SELECTOR
      masquerade as a slow one for a whole baseline. When a step reports
      no measurement at all, suspect the selector before the clock.
    """
    try:
        page.wait_for_selector(selector, timeout=timeout_ms, state="visible")
    except PlaywrightTimeoutError:
        pass
    try:
        page.click(selector, timeout=timeout_ms, force=True)
    except PlaywrightTimeoutError:
        pass


def install_instrumentation(context) -> None:
    """Arm the WebSocket/onRender hooks for every page this context opens.

    Inputs: context - a Playwright ``BrowserContext``.
    Output: None.
    """
    context.add_init_script(INSTRUMENT_JS)


def login_via_ui(page, base_url: str, totp_secret: str, timeout_ms: int = 30000) -> float:
    """Drive the REAL login form: navigate, type a valid code, submit.

    Description: the code is computed locally with this run's own TOTP
      secret (never typed by a human, but verified by the exact same
      server-side ``pyotp.TOTP.verify`` call a human's code would hit).
      This is the path used for every COLD/startup measurement, so that
      number includes real page load, real script execution and a real
      round trip to ``/api/v1/auth/verify``.
    Inputs: page - a Playwright ``Page``; base_url (str); totp_secret
      (str); timeout_ms (int).
    Output: float - milliseconds from navigation start to the launchpad
      screen reporting a non-zero visible box.
    Raises: AssertionError - the launchpad never became visible in time.
    """
    t0 = time.perf_counter()
    page.goto(base_url, wait_until="domcontentloaded")
    page.wait_for_selector("#totp-input", timeout=timeout_ms, state="visible")
    code = pyotp.TOTP(totp_secret).now()
    page.fill("#totp-input", code)
    # A successful login disables the button ("verifying...") and then
    # removes #auth-screen from view within well under a second as the
    # app transitions to the launchpad - see click_tolerant's docstring.
    # The actual pass/fail signal is the launchpad wait below.
    click_tolerant(page, "#login-btn")
    page.wait_for_function(
        "() => { const b = window.__visibleBox && window.__visibleBox('#launchpad-screen.active'); return !!(b && b.visible); }",
        timeout=timeout_ms,
    )
    return (time.perf_counter() - t0) * 1000.0


def inject_authenticated_session(page, base_url: str, token: str, timeout_ms: int = 30000) -> None:
    """Seed localStorage with a real bearer token, mimicking a return visit.

    Description: used for WARM measurements, where the interaction under
      test is not "log in" - navigating with the token already present is
      exactly what a real browser that logged in five minutes ago does.
    Inputs: page; base_url (str); token (str) - a real access token
      minted through ``PerfClient.login()``; timeout_ms (int).
    Output: None (page is navigated to ``base_url`` and reloaded once).
    """
    page.goto(base_url, wait_until="domcontentloaded")
    page.evaluate(
        "(tok) => localStorage.setItem('claude_tunnel_token', tok)", token
    )
    page.reload(wait_until="domcontentloaded")
    page.wait_for_function(
        "() => { const b = window.__visibleBox && window.__visibleBox('#launchpad-screen.active'); return !!(b && b.visible); }",
        timeout=timeout_ms,
    )


def ensure_sidebar_open(page, timeout_ms: int = 15000) -> None:
    """Open the real session sidebar if it is not already open.

    Description: clicking a session's row inside the sidebar closes it
      again (real production behavior - a conversation picker that stays
      open after you pick one would be an odd UI). So a SECOND switch
      through the sidebar needs it reopened first; calling this
      unconditionally before every sidebar interaction is what makes that
      safe on both the first and later switches, in one place, instead of
      duplicating the same open-if-closed check at every call site.
    Inputs: page; timeout_ms (int).
    Output: None.
    """
    sidebar_open = "#session-sidebar-panel.session-sidebar-panel--open"
    already_open = page.evaluate(
        f"() => {{ const b = window.__visibleBox('{sidebar_open}'); return !!(b && b.visible); }}"
    )
    if already_open:
        return
    click_tolerant(page, "#session-sidebar-toggle", timeout_ms=min(timeout_ms, 5000))
    page.wait_for_function(
        f"() => {{ const b = window.__visibleBox('{sidebar_open}'); return !!(b && b.visible); }}",
        timeout=timeout_ms,
    )


def open_session_row(
    page, session_id: str, timeout_ms: int = 30000, scope: str = "", wait_for_paint: bool = True
) -> float:
    """Click a session's real sidebar/launchpad row and wait for its terminal.

    Description: waits for the row to exist first (the sidebar renders
      asynchronously off its own list fetch), then performs a REAL mouse
      click through Playwright - not a synthetic dispatch - and waits for
      ``#terminal-screen.active`` to report a non-zero box. This is the
      "session entry" interaction (evidence table: "Session entry - 500 ms
      client delay").

      A session id can appear TWICE in the DOM at once: once in the
      launchpad's running-sessions list and once in the session sidebar's
      conversation list, and the one belonging to whichever screen is not
      currently ``.active`` is present but hidden (CSS, not absent).
      ``document.querySelector`` matches document order and can silently
      resolve to the HIDDEN copy - measured directly: a switch attempted
      via the bare id from inside a terminal (sidebar visible, launchpad
      not) timed out waiting for "visible" against the launchpad's own
      hidden copy of the row. ``scope`` disambiguates by prefixing the
      selector, e.g. ``"#session-sidebar-panel"`` when entering from the
      sidebar, ``"#launchpad-screen"`` when entering from the launchpad.
    Inputs: page; session_id (str); timeout_ms (int); scope (str) - a CSS
      selector prefix; "" (default) matches either copy, ambiguous only
      when both exist and differ in visibility. wait_for_paint (bool) -
      when True (default, used for a fresh entry from the launchpad, a
      genuinely new xterm instance), also waits for a FRESH non-blank
      onRender before returning, via ``_arm_render_hook`` - proof the pty
      is truly interactive, not merely that the DOM screen switched. When
      False (used for the intermediate "switch away" leg of a round trip,
      where the following call is the one whose timing is actually
      reported), only the DOM transition is awaited: a reused xterm
      instance does not reliably emit a fresh non-blank render on every
      switch (measured: scrollback that was already fully painted can
      repaint identically or not at all), so requiring one here would be
      waiting on a signal the switch is not guaranteed to produce.
    Output: float - milliseconds from click to the terminal screen
      reporting a non-zero visible box (plus, when wait_for_paint, a
      fresh onRender).
    """
    selector = f'{scope} [data-session-id="{session_id}"]'.strip()
    page.wait_for_selector(selector, timeout=timeout_ms, state="visible")
    t0 = page.evaluate("() => performance.now()")
    click_tolerant(page, selector)
    page.wait_for_function(
        "() => { const b = window.__visibleBox && window.__visibleBox('#terminal-screen.active'); return !!(b && b.visible); }",
        timeout=timeout_ms,
    )
    if wait_for_paint:
        t1 = _arm_render_hook(page, timeout_ms=timeout_ms)
    else:
        _ensure_render_hook(page, timeout_ms=timeout_ms)
        t1 = page.evaluate("() => performance.now()")
    return float(t1) - float(t0)


def _ensure_render_hook(page, timeout_ms: int = 30000) -> None:
    """Wait for a terminal instance to exist, then hook its onRender.

    Description: idempotent per xterm ``Terminal`` instance (see
      ``perf_instrument.js``'s ``__armRenderHook``) - safe to call again
      after a session switch that reuses the same instance. Does NOT wait
      for anything to have painted and does NOT touch the render/WS logs;
      callers that need "prove the pty is actually live" use
      ``_arm_render_hook`` instead.
    Inputs: page; timeout_ms (int).
    Output: None.
    Raises: AssertionError - no terminal instance appeared in time.
    """
    page.wait_for_function(
        "() => !!(window.TerminalController && window.TerminalController.term)",
        timeout=timeout_ms,
    )
    ok = page.evaluate("() => window.__armRenderHook()")
    assert ok, "xterm Terminal instance did not accept the render hook"


def _arm_render_hook(page, timeout_ms: int = 30000) -> None:
    """Hook onRender, then wait for a FRESH, real first paint.

    Description: the server's WS handshake drops any client input sent
      before the client's own ``pty_resize`` response completes (see
      ``tests/real_hook_app.py``'s module docstring for the same finding
      against this exact server - "the user can't have typed anything
      yet"). ``#terminal-screen`` can report a non-zero visible box before
      that handshake finishes, so a keystroke sent immediately after it
      can be silently swallowed with no error anywhere. Waiting for the
      shell's own first non-blank render is proof the handshake completed
      and the pty is live - a paint-based readiness signal, consistent
      with the rest of this harness, rather than a fixed sleep.

      CLEARS the render/WS logs before waiting (the same xterm instance
      is reused across a session switch, so a stale non-blank render left
      over from the PREVIOUS session would otherwise satisfy this
      instantly and prove nothing about the session just entered). This
      makes it the wrong choice for a caller that still needs to read log
      entries from BEFORE this call - such callers use
      ``_ensure_render_hook`` instead.
    Inputs: page; timeout_ms (int).
    Output: float - the BROWSER-CLOCK (``performance.now()``) timestamp of
      the first fresh non-blank render, captured BEFORE the post-paint
      settle wait below - so a caller timing "click to interactive" is
      not inflated by this function's own internal safety margin.
    Raises: AssertionError - no terminal instance, or no fresh paint, in time.
    """
    _ensure_render_hook(page, timeout_ms=timeout_ms)
    page.evaluate("() => window.__armEcho()")
    page.wait_for_function("() => window.__nonBlankRendered()", timeout=timeout_ms)
    first_paint_at = page.evaluate(
        "() => { const hit = window.__renderLog.find(r => r.text && r.text.trim().length > 0); return hit ? hit.t : null; }"
    )
    # A SECOND resize/reconnect handshake has been observed shortly after
    # the first paint (measured: a fresh 'pty_resize' send, "websocket
    # connected" and a repainted prompt, all AFTER the first prompt had
    # already rendered) - almost certainly the fit/geometry settling this
    # plan's item 2 names ("Replace unconditional 500 ms connection and
    # 50 ms fit waits..."). A keystroke sent while that second handshake
    # is in flight can be silently dropped exactly like the first one.
    # Mirrors tests/real_hook_app.py's own HANDSHAKE_SETTLE_SECONDS for
    # the same reason, then clears the logs again so a caller's own
    # NEXT measurement starts from a clean window rather than this
    # settle period's noise. This wait is deliberately EXCLUDED from the
    # returned timestamp above: it is a harness safety margin, not part
    # of what a user experiences as "the session became interactive".
    page.wait_for_timeout(1200)
    page.evaluate("() => window.__armEcho()")
    return float(first_paint_at)


def open_fresh_session_terminal(
    page, base_url: str, token: str, working_dir: str, label: str, timeout_ms: int = 30000
) -> tuple[dict, float]:
    """Create a session via the page's own fetch, then paint it in-page.

    Description: the create POST is issued from WITHIN the authenticated
      page (not from an external HTTP client), so the request carries the
      same token, origin and timing characteristics a real click on a
      "new session" control would produce. The paint step calls
      ``window.App.showTerminal(session)`` directly - the REAL
      production entry point ``app.js`` uses for both "just created" and
      "returning to an existing terminal" - rather than reproducing the
      launchpad's folder/provider-picker UI, which is a separate,
      not-yet-built surface (the session action menu this plan adds) and
      out of scope for this baseline. See the module docstring on
      ``run_baseline.py`` for the explicit statement of this narrowing.
    Inputs: page; base_url (str); token (str); working_dir (str) - an
      existing directory under the isolated server's work root; label
      (str); timeout_ms (int).
    Output: (session_json, launch_ms) - the created session body, and
      milliseconds from the create POST being issued to the terminal
      screen reporting a non-zero visible box.
    """
    t0 = page.evaluate("() => performance.now()")
    session = page.evaluate(
        """
        async ({ workingDir, label }) => {
            const resp = await fetch('/api/v1/sessions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + localStorage.getItem('claude_tunnel_token'),
                },
                body: JSON.stringify({
                    working_dir: workingDir,
                    auto_start_claude: true,
                    agent_type: 'shell',
                    label: label,
                }),
            });
            if (resp.status !== 201) {
                throw new Error('create refused: ' + resp.status + ' ' + (await resp.text()));
            }
            return await resp.json();
        }
        """,
        {"workingDir": working_dir, "label": label},
    )
    page.evaluate(
        "(s) => window.App.showTerminal(s)", session
    )
    page.wait_for_function(
        "() => { const b = window.__visibleBox && window.__visibleBox('#terminal-screen.active'); return !!(b && b.visible); }",
        timeout=timeout_ms,
    )
    t1 = _arm_render_hook(page, timeout_ms=timeout_ms)
    return session, float(t1) - float(t0)


def measure_typing_echo(page, count: int = 20, settle_ms: int = 3000) -> dict:
    """Type ``count`` distinct characters and prove each one painted.

    Description: for every character, arms the render hook, presses the
      key (a real Playwright keyboard event, not a synthesized DOM
      event), then polls ``window.__echoSnapshot`` until it reports a
      render whose visible viewport text contains that character AFTER
      the character was sent. Requires ``_arm_render_hook`` to already
      have been called (``open_session_row`` / ``open_fresh_session_terminal``
      do this).
    Inputs: page; count (int) - how many keystrokes; settle_ms (int) -
      per-keystroke timeout.
    Output: dict with three float lists, all in milliseconds:
      ``dispatch_to_send`` (Playwright press() call to the app's own
      ws.send - browser input-handling + IPC overhead), ``send_to_recv``
      (ws.send to the first WS message back - network + server, not
      further separable without server-side tracing), ``recv_to_render``
      (message arrival to xterm's onRender - browser render scheduling),
      and ``total`` (dispatch to render, the number the plan's 50ms
      target is measured against).
    """
    dispatch_to_send: list[float] = []
    send_to_recv: list[float] = []
    recv_to_render: list[float] = []
    total: list[float] = []

    for i in range(count):
        ch = _ECHO_ALPHABET[i % len(_ECHO_ALPHABET)]
        t_arm = page.evaluate("() => window.__armEcho()")
        t_dispatch_start = time.perf_counter()
        page.keyboard.press(ch)
        deadline = time.perf_counter() + (settle_ms / 1000.0)
        snap = None
        while time.perf_counter() < deadline:
            snap = page.evaluate("(needle) => window.__echoSnapshot(needle)", ch)
            if snap and snap.get("rendered"):
                break
            time.sleep(0.005)
        if not snap or not snap.get("rendered"):
            raise AssertionError(
                f"keystroke {ch!r} (#{i}) never rendered within {settle_ms}ms - "
                f"snapshot={snap}"
            )
        sent_at = snap.get("sentAt")
        recv_at = snap.get("recvAt")
        render_at = snap.get("renderAt")
        # t_arm is the browser clock at arm time; everything else is on
        # the same clock, so deltas below never cross a process boundary.
        if sent_at is not None:
            dispatch_to_send.append(max(0.0, sent_at - t_arm))
        if sent_at is not None and recv_at is not None:
            send_to_recv.append(max(0.0, recv_at - sent_at))
        if recv_at is not None and render_at is not None:
            recv_to_render.append(max(0.0, render_at - recv_at))
        total.append(max(0.0, render_at - t_arm))
        # Backspace so the next keystroke's expected character cannot
        # already be sitting on screen from this one.
        page.keyboard.press("Backspace")
        time.sleep(0.02)

    return {
        "dispatch_to_send": dispatch_to_send,
        "send_to_recv": send_to_recv,
        "recv_to_render": recv_to_render,
        "total": total,
    }


def measure_visible_box(page, selector: str, action, settle_ms: int = 3000) -> Optional[float]:
    """Run ``action()`` and time until ``selector`` reports a visible box.

    Inputs: page; selector (str) - a CSS selector; action (Callable[[],
      None]) - performs the click/keypress that should reveal it;
      settle_ms (int).
    Output: Optional[float] - milliseconds, or None if it never became
      visible (a could-not-measure, reported as such rather than guessed).
    """
    t0 = page.evaluate("() => performance.now()")
    action()
    deadline = time.perf_counter() + (settle_ms / 1000.0)
    while time.perf_counter() < deadline:
        box = page.evaluate("(sel) => window.__visibleBox(sel)", selector)
        if box and box.get("visible"):
            return float(box["t"]) - float(t0)
        time.sleep(0.004)
    return None


def measure_scroll_frame_times(page, container_selector: str, distance_px: int = 4000, steps: int = 40) -> list[float]:
    """Scroll a container programmatically and record inter-frame gaps.

    Description: proxy for "archive scrolling" jank - it drives
      ``requestAnimationFrame`` timestamps around a scripted scroll of a
      real, currently-rendered list container (see
      ``run_baseline.py`` for which container is used and why), rather
      than a synthetic harness. A frame gap much above the ~16.7ms 60Hz
      budget is dropped-frame evidence; this returns every gap so the
      caller can take percentiles.
    Inputs: page; container_selector (str); distance_px (int) - total
      scroll distance; steps (int) - how many incremental scrollTop
      writes to spread it over.
    Output: list[float] - consecutive requestAnimationFrame deltas, ms.
    """
    return page.evaluate(
        """
        async ({ sel, distance, steps }) => {
            const el = document.querySelector(sel);
            if (!el) return [];
            const gaps = [];
            let last = null;
            function frame(ts) {
                if (last !== null) gaps.push(ts - last);
                last = ts;
            }
            const perStep = Math.max(1, Math.floor(distance / steps));
            for (let i = 0; i < steps; i++) {
                el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + perStep);
                await new Promise((resolve) => requestAnimationFrame((ts) => { frame(ts); resolve(); }));
            }
            return gaps;
        }
        """,
        {"sel": container_selector, "distance": distance_px, "steps": steps},
    )
