#!/usr/bin/env python3
"""Measure the current tip against the plan's performance targets.

THIS IS THE HARNESS THE REST OF docs/webui-performance-and-session-menu-plan.md
IS JUDGED AGAINST. It is spec item 1's "establish measurements" half, run
once here to also produce the baseline every later phase is compared to.

WHAT IT MEASURES, against one ISOLATED, real ``src.main:app`` server this
script boots itself (see ``perf_env.PerfServer``) - never the operator's
real installation, never the live ``cloude`` tmux socket:

  - typing echo, proven by xterm's own ``onRender`` paint callback, not a
    parser callback (see ``perf_browser.py``'s module docstring for why
    that distinction is load-bearing here)
  - session entry (launchpad row -> interactive terminal)
  - session switching, cold and warm, unchanged geometry
  - launch (create -> interactive terminal)
  - a menu (the session sidebar's real slide-out panel)
  - settings (the real settings panel)
  - notifications, hook-to-visible-toast (via the app's own documented
    canonical synthetic-toast entry point - see ``PerfClient.create_toast``
    for exactly what is and is not measured by that substitution)
  - archive-scrolling frame times, proxied by the launchpad's own running-
    sessions list at N=50 (see the module docstring section below, "ABOUT
    THE ARCHIVE PROXY", for why)
  - startup, cold (real TOTP login, fresh browser context) and warm
    (reload with a token already held)
  - idle CPU and memory of the server process itself, at each session count

WHY EVERY SESSION IS ``agent_type="shell"``. The plan explicitly requires
measuring "agent startup and external-service latency separately" from
the rest. A bare interactive shell (``AgentsConfig.shell_command``, a
first-class reserved agent type - not a hijacked config override) answers
every keystroke deterministically and in well under a millisecond of its
own compute, with no external API, no token cost, and no run-to-run
variance from a language model's own response time. That isolates
everything this harness's targets are actually about: the browser, the
WebSocket, tmux, and this server's own request handling. A real ``claude``
agent's startup and per-turn latency is a second, clearly separate
question, and is deliberately NOT folded into these numbers - see
``docs/perf-baseline-2026-09-10.md``'s methodology section for how a later
phase can add it as its own opt-in measurement, the same way
``tests/test_led_real_hooks.py`` gates its real-agent run behind
``CLOUDE_REAL_HOOK_TESTS=1``.

WHAT "BROWSER / NETWORK / SUBPROCESS / DATABASE / AGENT TIME" MEANS HERE,
GIVEN THIS SCRIPT MAY NOT EDIT ``src/``. This harness has no server-side
tracing to attribute a single request's time across those five buckets
internally - adding that instrumentation is explicitly out of this file's
fence (three other agents own ``client/`` and ``src/`` tonight). Instead:

  - "browser" and "network+server" are split CLIENT-SIDE, on one clock
    (the page's own ``performance.now()``): the gap from an armed
    interaction to the application's own ``WebSocket.send`` is browser
    input-handling overhead; the gap from that send to the first message
    back is network-plus-server combined (the two cannot be told apart
    without a server-side timestamp); the gap from that message to
    xterm's ``onRender`` is browser render scheduling.
  - "subprocess" is measured OUT OF PROCESS, by counting the server
    pid's live child processes (``perf_client.count_descendants``) across
    an interaction window - every ``tmux`` CLI invocation is a transient
    child of this server, so a nonzero count during a window is direct
    evidence of a subprocess spawned to serve it, independent of any
    internal logging.
  - "database" is measured DIRECTLY against this run's own throwaway
    ``cloude.db`` (a plain ``SELECT`` timed with a fresh connection,
    scaled to the session count already on that server) rather than
    attributed to one interaction's critical path, because no interaction
    this harness drives is guaranteed to touch the database inline with
    the response the browser is waiting on - see ``_measure_db_cost``.
  - "agent" time is out of scope for the deterministic baseline by
    construction (see above) and is reported as such, not as zero.

ABOUT THE ARCHIVE PROXY. The plan's own evidence table gives the message
archive a 264-361 ms server-side scan cost, but making that number real
would mean synthesizing valid rows in the ``message_*`` schema (hosts,
corpora, projects, transcripts, lines, bodies) or running the real corpus
ingester against fabricated transcript files - either one a correctness
risk to take on inside a performance harness, and out of proportion to
what this file's fence and time budget allow. What is measured instead is
frame-timing (``requestAnimationFrame`` deltas) while programmatically
scrolling the launchpad's OWN real, currently-rendered running-sessions
list at N=50 - real CSS, real DOM, real paint, just not the archive's own
virtualization code. This is reported as a proxy, explicitly, and a real
archive-scroll measurement is named as a follow-up in the baseline doc
rather than silently stood in for.

USAGE

    venv/bin/python3 scripts/perf/run_baseline.py
    venv/bin/python3 scripts/perf/run_baseline.py --sessions 1,10,50
    venv/bin/python3 scripts/perf/run_baseline.py --quick   # smoke-sized

Every run is self-contained: it boots its own server on a free port at or
above 5001, its own throwaway tmux socket, and tears both down (plus every
temp directory) in a ``finally``, whatever happens.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from perf_client import PerfClient, sample_process, wait_until  # noqa: E402
from perf_env import PerfServer  # noqa: E402
from perf_stats import fmt_ms, summarize, verdict  # noqa: E402

#: The plan's own targets (Validation and delivery table), named exactly
#: as this harness's closest interaction so a reader can match them by eye.
PLAN_TARGETS_MS = {
    "typing_echo_total": 50.0,          # "Deterministic terminal echo p95 <= 50 ms"
    "session_switch_warm": 200.0,       # "Warm switch with unchanged geometry p95 <= 200 ms"
    "menu_open": 16.7,                  # "Click/menu feedback within one 60 Hz frame"
    "notification_toast": 100.0,        # "Local hook to visible toast p95 <= 100 ms"
}


def _quick_reps(quick: bool, normal: int, quick_n: int) -> int:
    """Repetition count for one measurement kind, collapsed for --quick.

    Inputs: quick (bool); normal (int); quick_n (int).
    Output: int.
    """
    return quick_n if quick else normal


def _measure_db_cost(state_dir: Path, session_count: int) -> Optional[float]:
    """Time one representative read against this run's own ``cloude.db``.

    Description: opens a FRESH connection (matching the app's own
      per-call connection pattern rather than reusing a warm handle) and
      times a ``SELECT COUNT(*) FROM sessions``. Not attributed to any
      one interaction's critical path - see the module docstring.
    Inputs: state_dir (Path) - this run's isolated state directory;
      session_count (int) - recorded alongside the timing for context.
    Output: Optional[float] - milliseconds, or None when the database
      file does not exist (never guessed as zero).
    """
    db_path = state_dir / "cloude.db"
    if not db_path.exists():
        return None
    t0 = time.perf_counter()
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("SELECT COUNT(*) FROM sessions").fetchone()
    finally:
        conn.close()
    return (time.perf_counter() - t0) * 1000.0


def _idle_sample(pid: int, seconds: float = 1.5) -> dict:
    """A short idle CPU/RSS/child-count reading for one server pid.

    Inputs: pid (int); seconds (float) - how long to let it sit idle
      before sampling.
    Output: dict - {'cpu_percent', 'rss_kb', 'child_count'}, or a dict of
      Nones when the process could not be sampled.
    """
    time.sleep(seconds)
    sample = sample_process(pid)
    if sample is None:
        return {"cpu_percent": None, "rss_kb": None, "child_count": None}
    return {
        "cpu_percent": sample.cpu_percent,
        "rss_kb": sample.rss_kb,
        "child_count": sample.child_count,
    }


def run_for_session_count(n_sessions: int, quick: bool = False) -> dict:
    """Boot one isolated server, populate it, measure everything, tear down.

    Inputs: n_sessions (int) - background shell sessions already running
      before the interactive measurements begin (in addition to the ones
      the measurements themselves create); quick (bool) - collapse every
      repetition count for a fast smoke run.
    Output: dict - every raw sample list plus idle-resource readings for
      this session count, keyed for ``build_report`` to consume.
    """
    import perf_browser  # local import: requires playwright, optional at module scope

    result: dict = {"n_sessions": n_sessions, "quick": quick}

    def _safe(label: str, fn, default):
        """Run one measurement step; on failure, log and keep going.

        Description: several interactions in this suite depend on real
          browser timing races this harness cannot fully control (a
          second reconnect handshake, a session sidebar closing itself
          after a pick) - see the switch/menu/settings sections below for
          measured examples. A failure in ONE of them must not discard
          every OTHER measurement already collected for this session
          count; it is recorded as a named miss instead; ``verdict()`` in
          ``perf_stats.py`` already renders an empty sample as
          "N/A (unmeasured)" rather than a false pass.
        Inputs: label (str) - for the stderr note; fn (Callable[[], T]);
          default (T) - stored in place of a raised exception's result.
        Output: T - fn()'s return value, or ``default`` on failure.
        """
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - deliberately broad: this is a per-step isolation boundary, not a swallow of a specific known error
            print(f"measurement step {label!r} failed, continuing: {exc}", file=sys.stderr)
            return default

    with PerfServer() as server:
        server.start()
        result["boot_seconds"] = server.boot_seconds

        client = PerfClient(server.base_url, server.totp_secret)
        client.login()

        idle_at_zero = _idle_sample(server.pid, seconds=1.0)
        result["idle_at_zero_sessions"] = idle_at_zero

        # Background sessions: everything except the two this harness
        # will drive interactively (created separately, below, so their
        # ids are known to the measurement code).
        background_ids = []
        run_tag = uuid.uuid4().hex[:8]
        for i in range(max(0, n_sessions - 2)):
            body = client.create_session(server.work_dir, f"perf-bg-{run_tag}-{i}")
            background_ids.append(body["id"])

        def _rows_ready() -> bool:
            rows = client.list_sessions()
            return len(rows) >= len(background_ids)

        wait_until(_rows_ready, timeout=30.0)

        idle_at_n = _idle_sample(server.pid, seconds=1.5)
        result["idle_at_n_sessions"] = idle_at_n
        result["db_read_ms_at_n"] = _measure_db_cost(Path(server._state_dir), n_sessions)

        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                perf_browser.install_instrumentation(context)
                page = context.new_page()

                # -- startup, cold: the real TOTP login form -------------- #
                # Bounded retry: a fresh navigation against a just-started
                # server has been observed to occasionally miss the
                # launchpad's readiness window under heavy machine load
                # (this harness's own boot detection and the browser's
                # script execution compete for the same CPU). Each retry
                # is still a full fresh navigation/login, so it is still
                # measuring "cold" - only a failed attempt is discarded,
                # never blended into the kept sample.
                last_login_error = None
                for attempt in range(3):
                    try:
                        result["startup_cold_ms"] = perf_browser.login_via_ui(
                            page, server.base_url, server.totp_secret
                        )
                        last_login_error = None
                        break
                    except Exception as exc:  # noqa: BLE001 - retried below; re-raised if exhausted
                        last_login_error = exc
                        print(f"cold login attempt {attempt + 1} failed: {exc}", file=sys.stderr)
                if last_login_error is not None:
                    raise last_login_error

                # A second entry session so switching/entry have somewhere
                # real to point at, distinct from the launch-created one.
                entry_session = client.create_session(server.work_dir, f"perf-entry-{run_tag}")

                def _entry_row_ready() -> bool:
                    return client.row_for(entry_session["id"]) is not None

                wait_until(_entry_row_ready, timeout=15.0)
                page.wait_for_function(
                    "(sid) => !!document.querySelector('[data-session-id=\"' + sid + '\"]')",
                    arg=entry_session["id"],
                    timeout=15000,
                )

                # -- launch, cold: create through the page's own fetch ---- #
                launch_session, launch_cold_ms = perf_browser.open_fresh_session_terminal(
                    page, server.base_url, client.token, server.work_dir, f"perf-launch-cold-{run_tag}"
                )
                result["launch_cold_ms"] = launch_cold_ms

                # -- typing, cold then warm, on the freshly launched session #
                typing_cold_n = _quick_reps(quick, 5, 3)
                typing_warm_n = _quick_reps(quick, 20, 4)
                result["typing_cold"] = perf_browser.measure_typing_echo(page, count=typing_cold_n)
                result["typing_warm"] = perf_browser.measure_typing_echo(page, count=typing_warm_n)

                # -- session entry: launchpad -> the pre-existing session -- #
                # (returns to the launchpad first via the sidebar's "home"
                # affordance is a separate, not-yet-selector-stable flow;
                # this harness instead opens a second page so "entry" is
                # measured from a fresh, unattached view - equally real,
                # and robust to whichever "back to launcher" control ships.)
                entry_page = context.new_page()
                perf_browser.inject_authenticated_session(entry_page, server.base_url, client.token)
                entry_page.wait_for_function(
                    "(sid) => !!document.querySelector('[data-session-id=\"' + sid + '\"]')",
                    arg=entry_session["id"],
                    timeout=15000,
                )
                result["entry_cold_ms"] = _safe(
                    "entry_cold",
                    lambda: perf_browser.open_session_row(entry_page, entry_session["id"]),
                    None,
                )
                entry_page.close()

                # Switch to the entry session, then back: cold, then warm.
                # Both directions go through the real session sidebar, not
                # the launchpad - see open_session_row's docstring for why
                # the launchpad's own (hidden) copy of the row is the
                # wrong target once a terminal is active. Proof of paint
                # on the way BACK to launch_session is onRender against a
                # NON-BLANK render (wait_for_paint=True), not a marker
                # printed earlier: measured directly, a session re-entered
                # through the sidebar a second time can redraw with a
                # clear rather than a scrollback replay (an
                # AssertionError this design replaced dumped the actual
                # renders - two blank frames then a bare prompt, no
                # history at all), so a fixed marker's survival is not a
                # reliable signal here. A bare prompt is still real proof
                # the target session's own pty is live and painted -
                # exactly what open_fresh_session_terminal already relies
                # on for the very same reason.
                sidebar_scope = "#session-sidebar-panel"
                perf_browser.ensure_sidebar_open(page)
                switch_cold_ms = _safe(
                    "session_entry_switch_target",
                    lambda: perf_browser.open_session_row(
                        page, entry_session["id"], scope=sidebar_scope, wait_for_paint=False
                    ),
                    None,
                )
                result["session_entry_switch_target_ms"] = switch_cold_ms
                result["session_switch_cold_ms"] = _safe(
                    "session_switch_cold",
                    lambda: perf_browser.open_session_row(
                        page, launch_session["id"], scope=sidebar_scope, wait_for_paint=True
                    ),
                    None,
                )
                # And again, both directions warm: WS already open on both
                # ends, geometry unchanged - exactly the plan's "warm switch
                # with unchanged geometry" scenario. The sidebar closed
                # itself when the row above was picked, so it is reopened
                # here rather than assumed still open. Both directions are
                # wrapped in _safe: repeated switches to the SAME session
                # within one run have been measured to occasionally miss
                # the paint-proof window even when the cold leg above just
                # succeeded (a real timing race in the app's own reconnect
                # path, not a harness defect - see open_session_row's
                # docstring), and one miss here must not cost every later
                # measurement in this session-count run.
                _safe(
                    "session_switch_warm_setup",
                    lambda: (
                        perf_browser.ensure_sidebar_open(page),
                        perf_browser.open_session_row(
                            page, entry_session["id"], scope=sidebar_scope, wait_for_paint=False
                        ),
                    ),
                    None,
                )
                result["session_switch_warm_ms"] = _safe(
                    "session_switch_warm",
                    lambda: (
                        perf_browser.ensure_sidebar_open(page),
                        perf_browser.open_session_row(
                            page, launch_session["id"], scope=sidebar_scope, wait_for_paint=True
                        ),
                    )[-1],
                    None,
                )

                # -- launch, warm: create a second time, server/tmux warm - #
                launch_warm_result = _safe(
                    "launch_warm",
                    lambda: perf_browser.open_fresh_session_terminal(
                        page, server.base_url, client.token, server.work_dir, f"perf-launch-warm-{run_tag}"
                    ),
                    (None, None),
                )
                result["launch_warm_ms"] = launch_warm_result[1]

                # -- menu: the real session-sidebar slide-out panel ------- #
                def _open_menu():
                    perf_browser.click_tolerant(page, "#session-sidebar-toggle")

                def _close_menu():
                    page.keyboard.press("Escape")

                result["menu_open_cold_ms"] = _safe(
                    "menu_open_cold",
                    lambda: perf_browser.measure_visible_box(
                        page, "#session-sidebar-panel.session-sidebar-panel--open", _open_menu
                    ),
                    None,
                )
                _close_menu()
                page.wait_for_timeout(150)
                result["menu_open_warm_ms"] = _safe(
                    "menu_open_warm",
                    lambda: perf_browser.measure_visible_box(
                        page, "#session-sidebar-panel.session-sidebar-panel--open", _open_menu
                    ),
                    None,
                )
                _close_menu()
                page.wait_for_timeout(150)

                # -- settings: the real settings panel --------------------- #
                #
                # #settingsBtn IS NOT IN THE HEADER ROW. It lives inside the
                # header overflow dropdown, and that is why this step read
                # n/a in every column of the 2026-09-10 baseline.
                # client/js/header-menu.js re-parents both overflow controls
                # (`HEADER_MENU_CONTROL_IDS` = logoutBtn, settingsBtn) into
                # `#header-menu-panel` at `_fold()`, `applyLayout()` calls
                # that unconditionally at EVERY width ("an overflow, not a
                # responsive fold any more"), and the panel is created with
                # `panel.hidden = true`.
                #
                # So the button really has no box until the kebab is opened,
                # for the harness and for a human alike. That is why a
                # `wait_for_selector(state="visible")` did not help and why
                # `force=True` could not either: force bypasses hit-testing,
                # not "has no box at all". The failure was deterministic
                # rather than a race, which is what the baseline's own note
                # meant when it said the cause is not simply timing.
                #
                # THE APP IS NOT AT FAULT AND THERE IS NOTHING TO FILE. The
                # step was measuring an interaction nobody can perform. The
                # real one is two clicks: open the overflow, then settings.
                #
                # The overflow is opened OUTSIDE the timed callback on
                # purpose. measure_visible_box stamps t0 and then runs the
                # action, so opening the menu inside it would bill the
                # menu's own animation to "settings open" and the number
                # would stop being about settings.
                # IT HAS TO BE IDEMPOTENT AND IT HAS TO RETRY, and both of
                # those came out of measuring rather than reading. The
                # toggle TOGGLES, and this step cannot assume which state
                # the previous pass left it in: header-menu.js collapses the
                # panel when a control inside it is clicked, and Escape
                # closes the panel as well as the settings modal. So a
                # single unconditional click could just as easily shut the
                # menu as open it, and a single conditional click can land
                # while the settings modal is still on its way out and do
                # nothing at all. Both were observed on the warm pass.
                #
                # THE CONDITION IS THE BUTTON, NOT THE PANEL. What this
                # step needs is `#settingsBtn` clickable; the panel is only
                # the mechanism. Keying on the panel would leave the loop
                # trusting a proxy for the thing it actually wants.
                def _overflow_is_open() -> bool:
                    return bool(page.is_visible("#settingsBtn"))

                def _open_header_overflow(attempts: int = 5) -> None:
                    for _ in range(attempts):
                        if _overflow_is_open():
                            return
                        perf_browser.click_tolerant(page, "#header-menu-toggle")
                        try:
                            page.wait_for_selector(
                                "#settingsBtn", state="visible", timeout=1000
                            )
                            return
                        except perf_browser.PlaywrightTimeoutError:
                            # Only Playwright's own timeout is swallowed, and
                            # only to take another attempt. If every attempt
                            # fails the measurement below reports a
                            # could-not-measure, which is the honest answer;
                            # raising here would turn one unmeasured row into
                            # a dead run.
                            page.wait_for_timeout(150)

                def _open_settings():
                    perf_browser.click_tolerant(page, "#settingsBtn")

                def _close_settings():
                    # WAIT FOR IT TO ACTUALLY BE GONE. The modal overlay
                    # sits over the header, so re-opening the overflow while
                    # it is still on screen clicks the overlay instead of
                    # the toggle. Escape alone plus a fixed sleep was not
                    # enough under load.
                    page.keyboard.press("Escape")
                    try:
                        page.wait_for_selector(
                            "#settings-panel-body", state="hidden", timeout=3000
                        )
                    except perf_browser.PlaywrightTimeoutError:
                        # Same reasoning as above: a close that did not
                        # complete is for the next step's own retry to
                        # survive, not for this helper to raise on.
                        pass

                _open_header_overflow()
                result["settings_open_cold_ms"] = _safe(
                    "settings_open_cold",
                    lambda: perf_browser.measure_visible_box(page, "#settings-panel-body", _open_settings),
                    None,
                )
                _close_settings()
                page.wait_for_timeout(150)
                _open_header_overflow()
                result["settings_open_warm_ms"] = _safe(
                    "settings_open_warm",
                    lambda: perf_browser.measure_visible_box(page, "#settings-panel-body", _open_settings),
                    None,
                )
                _close_settings()
                page.wait_for_timeout(150)

                # -- notifications: hook (synthetic canonical endpoint) --- #
                # Broadcasts only reach a viewer of THIS session, so make
                # sure the page is actually looking at launch_session.
                def _run_notification_reps() -> list:
                    # page is currently on the launch_warm session (the
                    # last screen transition before this section), so
                    # launch_session's own row is unscoped-ambiguous
                    # again here - same class of bug as the switch
                    # section above, and the same fix: go through the
                    # sidebar explicitly rather than a bare selector.
                    perf_browser.ensure_sidebar_open(page)
                    perf_browser.open_session_row(
                        page, launch_session["id"], scope="#session-sidebar-panel", wait_for_paint=True
                    )
                    toast_reps = _quick_reps(quick, 8, 3)
                    samples = []
                    for i in range(toast_reps):
                        t0 = time.perf_counter()
                        client.create_toast(
                            launch_session["id"], "Notification", "perf check", f"toast-{i}"
                        )
                        deadline = time.perf_counter() + 3.0
                        seen = False
                        while time.perf_counter() < deadline:
                            count = page.evaluate(
                                "() => document.querySelectorAll('.toast-card, [class*=\"toast\"]').length"
                            )
                            if count and count > 0:
                                seen = True
                                break
                            time.sleep(0.005)
                        if seen:
                            samples.append((time.perf_counter() - t0) * 1000.0)
                        # Dismiss whatever is there so the next rep starts clean.
                        page.evaluate(
                            "() => document.querySelectorAll('.toast-card button, [class*=\"toast\"] button').forEach(b => b.click())"
                        )
                        time.sleep(0.1)
                    return samples

                result["notification_toast"] = _safe("notification_toast", _run_notification_reps, [])

                # -- archive-scroll proxy: launchpad running-sessions list - #
                # Fresh page, full N rows rendered, so the scroll actually
                # has somewhere to go.
                def _run_scroll_proxy() -> list:
                    list_page = context.new_page()
                    try:
                        perf_browser.inject_authenticated_session(list_page, server.base_url, client.token)
                        list_page.wait_for_timeout(300)
                        return perf_browser.measure_scroll_frame_times(
                            list_page, "#launchpad-screen .launchpad-scroll"
                        )
                    finally:
                        list_page.close()

                result["scroll_frame_gaps_ms"] = _safe("scroll_frame_gaps", _run_scroll_proxy, [])

                # -- startup, warm: reload with a token already present --- #
                def _run_startup_warm() -> float:
                    t0 = time.perf_counter()
                    page.reload(wait_until="domcontentloaded")
                    page.wait_for_function(
                        "() => { const b = window.__visibleBox && window.__visibleBox('#launchpad-screen.active'); return !!(b && b.visible); }",
                        timeout=15000,
                    )
                    return (time.perf_counter() - t0) * 1000.0

                result["startup_warm_ms"] = _safe("startup_warm", _run_startup_warm, None)

                context.close()
            finally:
                browser.close()

        idle_final = _idle_sample(server.pid, seconds=1.0)
        result["idle_final"] = idle_final
        client.close()

    return result


def build_report(all_results: list[dict]) -> tuple[str, str]:
    """Render the markdown baseline doc body and a short TODO.md summary.

    Inputs: all_results (list[dict]) - one entry per session count, as
      returned by ``run_for_session_count``.
    Output: (markdown_doc, todo_summary) - two strings.
    """
    lines: list[str] = []
    lines.append("# Performance baseline, 2026-09-10")
    lines.append("")
    lines.append(
        "Measured against the current tip with "
        "`venv/bin/python3 scripts/perf/run_baseline.py`, one isolated "
        "server per session count, throwaway tmux socket, `CLOUDE_TEST_MODE=1`, "
        "`agent_type=shell` for every session (no real `claude` binary, no "
        "LLM turns - see the harness module docstring for why)."
    )
    lines.append("")
    lines.append(
        "Reproduce with: `venv/bin/python3 scripts/perf/run_baseline.py "
        "--sessions " + ",".join(str(r["n_sessions"]) for r in all_results) + "`"
    )
    lines.append("")
    lines.append("## Plan targets")
    lines.append("")
    lines.append("| Interaction | Target | " + " | ".join(f"N={r['n_sessions']} p95 / verdict" for r in all_results) + " |")
    lines.append("|---|---|" + "---|" * len(all_results))

    def _lookup(r: dict, key_path: str):
        """Walk a dotted key path; normalize a scalar leaf into a list.

        Inputs: r (dict) - one session count's result; key_path (str).
        Output: list[float] - empty when the path is missing or None,
          a one-element list for a scalar leaf, the list itself for a
          list leaf (Nones filtered out either way).
        """
        node = r
        for part in key_path.split("."):
            node = (node or {}).get(part) if isinstance(node, dict) else None
        if node is None:
            return []
        values = node if isinstance(node, list) else [node]
        return [v for v in values if v is not None]

    def pct_of(all_results, key_path):
        return [summarize(_lookup(r, key_path)) for r in all_results]

    def target_row(label: str, key_path: str, target: float) -> str:
        pcts = pct_of(all_results, key_path)
        cells = [f"{fmt_ms(p.p95)} / {verdict(p.p95, target)} (n={p.n})" for p in pcts]
        return f"| {label} | <= {target} ms | " + " | ".join(cells) + " |"

    lines.append(target_row("Deterministic terminal echo (warm)", "typing_warm.total", PLAN_TARGETS_MS["typing_echo_total"]))
    lines.append(target_row("Warm switch, unchanged geometry", "session_switch_warm_ms", PLAN_TARGETS_MS["session_switch_warm"]))
    lines.append(target_row("Menu open (cold)", "menu_open_cold_ms", PLAN_TARGETS_MS["menu_open"]))
    lines.append(target_row("Local hook to visible toast", "notification_toast", PLAN_TARGETS_MS["notification_toast"]))
    lines.append("")

    lines.append("## Full measurements (p50 / p95 / p99, ms)")
    lines.append("")
    lines.append("| Interaction | " + " | ".join(f"N={r['n_sessions']}" for r in all_results) + " |")
    lines.append("|---|" + "---|" * len(all_results))

    def full_row(label: str, key_path: str) -> str:
        cells = []
        for r in all_results:
            p = summarize(_lookup(r, key_path))
            cells.append(f"{fmt_ms(p.p50)} / {fmt_ms(p.p95)} / {fmt_ms(p.p99)} (n={p.n})")
        return f"| {label} | " + " | ".join(cells) + " |"

    for label, key_path in [
        ("typing echo - dispatch to ws-send (browser), cold", "typing_cold.dispatch_to_send"),
        ("typing echo - ws-send to first byte back (network+server), cold", "typing_cold.send_to_recv"),
        ("typing echo - first byte to onRender (browser render), cold", "typing_cold.recv_to_render"),
        ("typing echo - total, cold", "typing_cold.total"),
        ("typing echo - dispatch to ws-send (browser), warm", "typing_warm.dispatch_to_send"),
        ("typing echo - ws-send to first byte back (network+server), warm", "typing_warm.send_to_recv"),
        ("typing echo - first byte to onRender (browser render), warm", "typing_warm.recv_to_render"),
        ("typing echo - total, warm", "typing_warm.total"),
        ("session entry (launchpad row -> interactive)", "entry_cold_ms"),
        ("session switch, cold", "session_switch_cold_ms"),
        ("session switch, warm (unchanged geometry)", "session_switch_warm_ms"),
        ("launch, cold (create -> interactive)", "launch_cold_ms"),
        ("launch, warm", "launch_warm_ms"),
        ("menu open, cold", "menu_open_cold_ms"),
        ("menu open, warm", "menu_open_warm_ms"),
        ("settings open, cold", "settings_open_cold_ms"),
        ("settings open, warm", "settings_open_warm_ms"),
        ("notification: hook to visible toast", "notification_toast"),
        ("archive-scroll proxy: frame gap (launchpad list, requestAnimationFrame)", "scroll_frame_gaps_ms"),
        ("startup, cold (real TOTP login)", "startup_cold_ms"),
        ("startup, warm (reload, token held)", "startup_warm_ms"),
    ]:
        lines.append(full_row(label, key_path))
    lines.append("")

    lines.append("## Server resources and boot")
    lines.append("")
    lines.append("| | " + " | ".join(f"N={r['n_sessions']}" for r in all_results) + " |")
    lines.append("|---|" + "---|" * len(all_results))
    lines.append(
        "| boot time (process start to /health 200) | "
        + " | ".join(f"{r['boot_seconds']:.2f} s" for r in all_results)
        + " |"
    )
    for label, key in [
        ("idle CPU % (0 sessions)", "idle_at_zero_sessions"),
        ("idle CPU % (N sessions, no viewer)", "idle_at_n_sessions"),
        ("idle CPU % (after full run)", "idle_final"),
    ]:
        cells = []
        for r in all_results:
            v = (r.get(key) or {}).get("cpu_percent")
            cells.append(f"{v:.1f}%" if v is not None else "n/a")
        lines.append(f"| {label} | " + " | ".join(cells) + " |")
    for label, key in [
        ("RSS, MB (0 sessions)", "idle_at_zero_sessions"),
        ("RSS, MB (N sessions, no viewer)", "idle_at_n_sessions"),
        ("RSS, MB (after full run)", "idle_final"),
    ]:
        cells = []
        for r in all_results:
            v = (r.get(key) or {}).get("rss_kb")
            cells.append(f"{v / 1024.0:.1f} MB" if v is not None else "n/a")
        lines.append(f"| {label} | " + " | ".join(cells) + " |")
    cells = []
    for r in all_results:
        v = r.get("db_read_ms_at_n")
        cells.append(fmt_ms(v))
    lines.append("| direct DB read (`SELECT COUNT(*) FROM sessions`), fresh connection | " + " | ".join(cells) + " |")
    lines.append("")

    doc = "\n".join(lines) + "\n"

    todo_lines = ["### Performance baseline, 2026-09-10"]
    for r in all_results:
        typing_p95 = summarize(r.get("typing_warm", {}).get("total") or []).p95
        switch_p95 = summarize([r.get("session_switch_warm_ms")] if r.get("session_switch_warm_ms") is not None else []).p95
        toast_p95 = summarize(r.get("notification_toast") or []).p95
        todo_lines.append(
            f"- N={r['n_sessions']}: typing echo warm p95 {fmt_ms(typing_p95)}, "
            f"warm switch {fmt_ms(switch_p95)}, toast {fmt_ms(toast_p95)}, "
            f"boot {r['boot_seconds']:.2f}s. Full table: "
            "docs/perf-baseline-2026-09-10.md"
        )
    todo_summary = "\n".join(todo_lines) + "\n"

    return doc, todo_summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sessions", default="1,10,50", help="comma-separated session counts")
    parser.add_argument("--quick", action="store_true", help="collapse repetition counts for a fast smoke run")
    parser.add_argument("--out", default=str(REPO_ROOT / "docs" / "perf-baseline-2026-09-10.md"))
    parser.add_argument("--raw-json", default=str(REPO_ROOT / "scripts" / "perf" / "perf-baseline-raw.json"))
    args = parser.parse_args()

    counts = [int(x) for x in args.sessions.split(",") if x.strip()]
    all_results = []
    for n in counts:
        print(f"=== measuring N={n} sessions (quick={args.quick}) ===", file=sys.stderr)
        result = run_for_session_count(n, quick=args.quick)
        all_results.append(result)

    doc, todo_summary = build_report(all_results)
    Path(args.out).write_text(doc)
    Path(args.raw_json).write_text(json.dumps(all_results, indent=2))
    print(doc)
    print("--- TODO.md summary ---", file=sys.stderr)
    print(todo_summary, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
