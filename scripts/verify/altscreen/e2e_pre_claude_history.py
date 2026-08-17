#!/usr/bin/env python3
"""Proof for the reported bug: a claude session with PRE-CLAUDE history.

THE CASE
--------
A user prints something in a shell - a banner, an motd, a git status, or
in the report that produced this file 400 numbered seed lines - and THEN
starts claude under ``tui: fullscreen``. Scrolling up showed the seed
lines, not claude's transcript.

Two things had to be true for that, and this script measures both against
real tmux panes, the app's real vendored xterm.js in real chromium, and
the real altscreen-scroll.js:

1. The client only ever holds the pre-claude history because the REJOIN
   path replayed it: ``capture-pane -S -3000`` on a pane whose foreground
   process owns the alternate screen reaches back past the TUI into
   whatever ran before it. ``rejoin_old`` below feeds exactly those bytes
   and shows the module classifying the screen as ``main`` - the buggy
   verdict, reproduced.
2. ``TmuxBackend.capture_scrollback`` now returns nothing for such a pane,
   so the client is painted by the server's Ctrl+L redraw alone.
   ``rejoin_new`` feeds exactly that and shows ``live``, a ctrl+o, and
   claude's own transcript arriving on screen.

It also holds the two paths that must NOT change: ``tui: default``, where
claude's conversation IS the terminal buffer, and a plain shell.

RUN
    python3 scripts/verify/altscreen/gen_transcript.py   # once, per lab dir
    python3 scripts/verify/altscreen/e2e_pre_claude_history.py

Everything is created on the throwaway socket named by ALTSB_SOCKET
(default ``sbgate``), never the socket the app itself uses.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import time

import e2e_altscreen as E

#: Scratch root holding one directory per renderer, each with its own
#: .claude/settings.json. Never the user's global setting.
LAB_ROOT = os.environ.get(
    "SBGATE_LAB", os.path.expanduser("~/Scratch/llmScratch/sbgate-lab")
)

#: The synthetic transcript gen_transcript.py writes.
SESSION_ID = "aaaaaaaa-0000-4000-8000-000000000001"

#: How many lines of shell output to print BEFORE claude starts. This is
#: the whole point: it is what the old gate scrolled instead of claude.
SEED_LINES = 400

#: Depth the rejoin path captures with, matching config.session.
CAPTURE_LINES = 3000


def seed_command() -> str:
    """Shell command that prints the pre-claude history."""
    return (
        'for i in $(seq 1 %d); do echo "SEEDLINE $i '
        '---------------------------------------"; done' % SEED_LINES
    )


def start_session(name: str, cwd: str, run_claude: bool) -> None:
    """Create one lab session, seed it, and optionally start claude.

    Args:
        name: tmux session name on the lab socket.
        cwd: working directory, which supplies .claude/settings.json.
        run_claude: when True, resume the synthetic transcript in it.
    """
    E.tmux("kill-session", "-t", name)
    time.sleep(0.3)
    E.tmux("new-session", "-d", "-s", name, "-x", "100", "-y", "30", "-c", cwd)
    time.sleep(1.0)
    E.tmux("send-keys", "-t", name, seed_command(), "Enter")
    time.sleep(4.0)
    if not run_claude:
        return
    E.tmux("send-keys", "-t", name, "claude --resume %s" % SESSION_ID, "Enter")
    for _ in range(40):
        time.sleep(1.0)
        if "❯" in E.tmux("capture-pane", "-p", "-t", name):
            break


def alternate_on(name: str) -> bool:
    """Read the pane's own ``#{alternate_on}``, the authority the server uses."""
    return E.tmux("display-message", "-p", "-t", name, "#{alternate_on}").strip() == "1"


def capture_scrollback(name: str) -> bytes:
    """Reproduce what the rejoin path used to send the client.

    Mirrors ``TmuxBackend.capture_scrollback`` flag for flag, WITHOUT its
    new alternate-screen skip, so the old behaviour can be measured.
    """
    out = subprocess.run(
        [E.TMUX, *E.SOCKET, "capture-pane", "-p", "-e", "-J",
         "-S", "-%d" % CAPTURE_LINES, "-t", name],
        capture_output=True, check=False,
    ).stdout
    return out.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


def repaint_bytes(name: str) -> bytes:
    """The bytes a Ctrl+L redraw puts on the wire, as the server's attach
    paint does for an alternate-screen pane."""
    pipe = os.path.join(tempfile.gettempdir(), "sbgate-%s-%d.raw" % (name, time.time()))
    open(pipe, "wb").close()
    E.tmux("pipe-pane", "-t", name, "-O", "cat >> %s" % pipe)
    time.sleep(0.4)
    E.tmux("send-keys", "-t", name, "C-l")
    time.sleep(2.5)
    E.tmux("pipe-pane", "-t", name)
    with open(pipe, "rb") as fh:
        return fh.read()


def pane_marker(name: str) -> int:
    """First ``TRANSCRIPT LINE N`` marker visible in the real pane, or -1."""
    m = re.search(r"TRANSCRIPT LINE (\d+)", E.tmux("capture-pane", "-p", "-t", name))
    return int(m.group(1)) if m else -1


class Browser:
    """The app's real xterm plus the real module, in real chromium."""

    def __init__(self, page: object) -> None:
        self.page = page

    def reset(self) -> None:
        """Fresh buffer, as a page load gives the client."""
        self.page.evaluate("() => { window.__term.reset(); window.__drain(); }")

    def feed(self, data: bytes) -> None:
        """Paint bytes into xterm exactly as the WS/replay paths do."""
        if data:
            self.page.evaluate("b => window.__feed(b)", list(data))
            self.page.wait_for_timeout(400)

    def info(self) -> dict:
        """Buffer facts plus the module's verdict and the visible top line."""
        return self.page.evaluate("""() => {
            var t = window.__term, b = t.buffer.active;
            return {
                type: b.type, baseY: b.baseY,
                state: window.AltScreenScroll.detectState(t),
                top: window.__topLine().slice(0, 62)
            };
        }""")

    def gesture(self, rows: int) -> list:
        """One scroll gesture. Returns the bytes the module produced."""
        self.page.evaluate("r => window.AltScreenScroll.scrollByRows(r)", rows)
        return self.page.evaluate("() => window.__drain()")

    def scroll_lines(self, rows: int) -> bool:
        """The terminal path the module hands a `main` verdict back to."""
        return self.page.evaluate("""(r) => {
            var t = window.__term, before = t.buffer.active.viewportY;
            t.scrollLines(r);
            return t.buffer.active.viewportY !== before;
        }""", rows)


def send_to_pane(name: str, chunks: list) -> int:
    """Write the module's bytes into the real pane. Returns the byte count."""
    n = 0
    for chunk in chunks:
        hexed = ["%02x" % b for b in chunk.encode("latin1", "replace")]
        subprocess.run(
            [E.TMUX, *E.SOCKET, "send-keys", "-t", name, "-H", *hexed], check=False
        )
        n += len(chunk)
    return n


def run(page: object) -> list:
    """Run every case. Returns the list of failed case names."""
    b = Browser(page)
    fails = []

    def check(name: str, ok: bool, detail: str) -> None:
        print("%-4s %s\n     %s" % ("PASS" if ok else "FAIL", name, detail))
        if not ok:
            fails.append(name)

    fs, cl, sh = "sbgate_fs", "sbgate_cl", "sbgate_sh"
    print("== building lab sessions (400 seed lines, then claude) ==")
    start_session(fs, os.path.join(LAB_ROOT, "fs"), run_claude=True)
    start_session(cl, os.path.join(LAB_ROOT, "classic"), run_claude=True)
    start_session(sh, "/tmp", run_claude=False)
    print("   fullscreen alternate_on=%s | classic alternate_on=%s | shell alternate_on=%s"
          % (alternate_on(fs), alternate_on(cl), alternate_on(sh)))
    check("the fullscreen pane is on the alternate screen and the others are not",
          alternate_on(fs) and not alternate_on(cl) and not alternate_on(sh),
          "this is the boundary both the server skip and the client gate use")

    print("\n== 1. THE BUG: rejoin replays the pre-claude history (old server) ==")
    old_replay = capture_scrollback(fs)
    b.reset()
    b.feed(old_replay)
    b.feed(repaint_bytes(fs))
    old = b.info()
    old_sent = b.gesture(-10)
    moved = b.scroll_lines(-10)
    print("   browser type=%s baseY=%d state=%s" % (old["type"], old["baseY"], old["state"]))
    print("   visible top BEFORE: [%s]" % old["top"])
    print("   after the gesture : [%s]" % b.info()["top"])
    check("reproduced: the gesture is given to the terminal buffer",
          old["state"] == "main" and not old_sent and moved,
          "%d replayed bytes put %d rows of pre-claude history under claude's "
          "paint, so the screen scrolls SEEDLINEs" % (len(old_replay), old["baseY"]))

    print("\n== 2. THE FIX: no replay for an alternate-screen pane (new server) ==")
    # A LIVE stream for this case, not discrete repaints: the module holds
    # its arrows back until the browser's own xterm shows the transcript
    # view, so the driver has to keep feeding pane bytes while it waits -
    # which is what the websocket does continuously in production.
    pipe = os.path.join(tempfile.gettempdir(), "sbgate-live-%d.raw" % time.time())
    open(pipe, "wb").close()
    E.tmux("pipe-pane", "-t", fs, "-O", "cat >> %s" % pipe)
    time.sleep(0.4)
    b.reset()
    with open(pipe, "rb") as fh:
        loop = E.Loop(page, fh)
        E.tmux("send-keys", "-t", fs, "C-l")
        loop.pump(1.5)
        new = b.info()
        print("   browser type=%s baseY=%d state=%s"
              % (new["type"], new["baseY"], new["state"]))
        print("   visible top BEFORE: [%s]  pane marker=%d"
              % (new["top"], pane_marker(fs)))
        check("claude owns the gesture now",
              new["state"] == "live",
              "same pane, same repaint, no fabricated history beneath it")

        n = 0
        for _ in range(3):
            page.evaluate("() => window.AltScreenScroll.scrollByRows(-10)")
            n += loop.flush_out()
            for _ in range(14):
                loop.pump(0.12)
                if loop.flush_out():
                    n += 1
                    break
            loop.pump(0.9)
        after = b.info()
    E.tmux("pipe-pane", "-t", fs)
    print("   visible top AFTER : [%s]  pane marker=%d" % (after["top"], pane_marker(fs)))
    check("the gesture reached CLAUDE's history, not the terminal's",
          "SEEDLINE" not in after["top"] and "TRANSCRIPT LINE" in after["top"]
          and E.pane_state() == "transcript",
          "%d bytes sent; claude's own transcript view is on screen and the "
          "browser shows claude content, never a seed line" % n)

    print("\n== 3. tui: default is untouched - the buffer IS claude there ==")
    b.reset()
    b.feed(capture_scrollback(cl))
    b.feed(repaint_bytes(cl))
    info = b.info()
    sent_cl = b.gesture(-10)
    moved_cl = b.scroll_lines(-10)
    print("   browser type=%s baseY=%d state=%s" % (info["type"], info["baseY"], info["state"]))
    print("   visible top: [%s] -> [%s]" % (info["top"], b.info()["top"]))
    check("classic renderer still scrolls its own buffer, nothing injected",
          info["state"] == "main" and not sent_cl and moved_cl,
          "bytes_sent=%d, scrollLines moved the viewport" % len(sent_cl))

    print("\n== 4. a plain shell is untouched ==")
    b.reset()
    b.feed(capture_scrollback(sh))
    info = b.info()
    sent_sh = b.gesture(-10)
    moved_sh = b.scroll_lines(-10)
    print("   browser type=%s baseY=%d state=%s" % (info["type"], info["baseY"], info["state"]))
    print("   visible top: [%s] -> [%s]" % (info["top"], b.info()["top"]))
    check("plain shell scrolls its own buffer, nothing injected",
          info["state"] == "main" and not sent_sh and moved_sh,
          "bytes_sent=%d, scrollLines moved the viewport" % len(sent_sh))

    for name in (fs, cl, sh):
        E.tmux("kill-session", "-t", name)
    return fails


def main() -> int:
    """Serve the harness, run every case, report."""
    from playwright.sync_api import sync_playwright

    E.TARGET = "sbgate_fs"
    srv = E.serve()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1000, "height": 640})
            page.goto("http://127.0.0.1:%d/e2e_harness.html" % E.PORT)
            fails = run(page)
            browser.close()
    finally:
        srv.shutdown()
    print("\n%s" % ("FAILURES: " + ", ".join(fails) if fails else "PRE-CLAUDE HISTORY ALL PASS"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
