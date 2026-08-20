#!/usr/bin/env python3
"""Measure the sidebar's INLINE RENAME in a real browser. Item 66.

Split out of scripts/verify_sidebar_groups.py, which reached the
project's 500-line budget once the item 62 cluster measurements landed.
Rename is the natural piece to lift: it is the only one of the three
items that drives a text editor rather than a layout, and it needs five
separate pages to itself.

Imported and run by verify_sidebar_groups.py, which stays the single
entry point the mutation suite calls. Runnable on its own too.

Inputs come from tests/manual/sidebar-sessions-geometry-harness.html,
whose fake API deliberately provides one renameable row, one row with
genuinely NULL ownership, and a rename endpoint that can be told to fail.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from verify_sidebar_sessions import (  # noqa: E402
    DENSITY_KEY,
    Report,
    assert_viewport,
    open_page,
)


def measure_inline_rename(browser, port: int, rep: Report) -> None:
    """Double-click opens an editor; Enter commits, Escape cancels, failure restores.

    EACH CASE GETS ITS OWN PAGE. A double-click on a row that CANNOT be
    renamed correctly falls through to activating the row, which closes
    the panel - so running the blocked case first left every later
    measurement pointing at a hidden list. That is a real behaviour, not a
    harness quirk, which is exactly why it must not be allowed to
    contaminate the next assertion.

    Inputs: browser; port (int); rep (Report). Output: None.
    """
    name_sel = '.session-sidebar-row[data-name="cloude_fstest"] .session-sidebar-row-name'

    # ---- THE THREE STATES ARE ALL ON SCREEN.
    page = open_page(browser, port, {DENSITY_KEY: "cozy"})
    assert_viewport(page, rep)
    g = page.evaluate("window.__sidebarMeasure()")
    states = set(g["renameStates"])
    rep.check(states == {"renameable", "unavailable", "unknown"},
              "ITEM 66: all THREE rename states are rendered, including CANNOT DETERMINE",
              f"states={sorted(states)}")
    rep.note(f"rename states on screen: {sorted(states)}")
    # 'unknown' must not be folded into 'unavailable'. The row whose
    # ownership is genuinely null is the one a `!r.x` test would silently
    # reclassify as external, inventing an answer nobody measured.
    unknown_rows = [r for r, s in zip(g["rows"], g["renameStates"]) if s == "unknown"]
    rep.check(len(unknown_rows) == 1,
              "ITEM 66: a null ownership stays UNKNOWN rather than becoming 'external'",
              f"unknown rows={[r['name'] for r in unknown_rows]}")
    page.close()

    # ---- OPEN, and the row must not change height doing it.
    page = open_page(browser, port, {DENSITY_KEY: "cozy"})
    before = page.evaluate("window.__sidebarMeasure()")
    before_h = [r for r in before["rows"] if r["name"] == "cloude_fstest"][0]["height"]
    page.dblclick(name_sel)
    page.wait_for_timeout(150)
    g2 = page.evaluate("window.__sidebarMeasure()")
    rep.check(g2["rename"] is not None,
              "ITEM 66: double-click on a renameable row opens the editor", "")
    if g2["rename"]:
        rep.check(g2["rename"]["focused"] is True,
                  "ITEM 66: the editor takes real DOM focus", "")
        rep.check(g2["rename"]["value"] == "cloude_fstest",
                  "ITEM 66: and starts with the current name in it",
                  f"value={g2['rename']['value']!r}")
        # A ROW THAT GROWS WHEN YOU DOUBLE-CLICK IT shoves every row below
        # it down while the pointer is still moving.
        rep.check(abs(g2["rename"]["rowHeight"] - before_h) < 1.0,
                  "ITEM 66: opening the editor does NOT change the row height",
                  f"before={before_h:.2f} during={g2['rename']['rowHeight']:.2f}")
        rep.check(g2["rename"]["width"] > 40,
                  "ITEM 66: the input has real painted width",
                  f"width={g2['rename']['width']:.2f}")
    # A SINGLE CLICK MUST NOT HAVE SWITCHED. If the deferral were broken
    # the panel would already be closed and there would be no editor at
    # all, which the assertions above would catch - but the panel state is
    # checked directly so the reason is legible.
    open_panel = page.evaluate(
        "document.getElementById('session-sidebar-panel').getAttribute('aria-hidden')")
    rep.check(open_panel != "true",
              "ITEM 66: the panel is still open after the double-click",
              f"panel aria-hidden={open_panel}")
    # COUNTED, not inferred from the panel. A broken deferral switches AND
    # still opens the editor, so the editor's presence proves nothing; only
    # the switch count distinguishes "deferred" from "switched anyway".
    rep.check(g2["switchCount"] == 0,
              "ITEM 66: the first click of the double-click did NOT switch conversation",
              f"switches={g2['switchCount']}")

    # ---- ESCAPE CANCELS. THE TEXT MUST ACTUALLY BE CHANGED FIRST, or
    # this proves nothing: an Escape that secretly committed an UNCHANGED
    # name is indistinguishable from a cancel. Typing a different name is
    # what makes the two outcomes different.
    page.keyboard.press("ControlOrMeta+a")
    page.keyboard.type("escape_should_discard")
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    g3 = page.evaluate("window.__sidebarMeasure()")
    rep.check(g3["rename"] is None, "ITEM 66: Escape closes the editor", "")
    rep.check(any(r["name"] == "cloude_fstest" for r in g3["rows"]),
              "ITEM 66: and the original name is restored",
              f"names={[r['name'] for r in g3['rows']][:3]}")
    rep.check(not any(r["name"] == "escape_should_discard" for r in g3["rows"]),
              "ITEM 66: Escape DISCARDS the typed name rather than committing it", "")
    page.close()

    # ---- ENTER COMMITS.
    page = open_page(browser, port, {DENSITY_KEY: "cozy"})
    page.dblclick(name_sel)
    page.wait_for_timeout(150)
    page.keyboard.press("ControlOrMeta+a")
    page.keyboard.type("renamed_ok")
    page.keyboard.press("Enter")
    page.wait_for_timeout(250)
    g4 = page.evaluate("window.__sidebarMeasure()")
    rep.check(g4["rename"] is None, "ITEM 66: Enter closes the editor", "")
    rep.check(any(r["name"] == "renamed_ok" for r in g4["rows"]),
              "ITEM 66: Enter COMMITS the new name into the row",
              f"names={[r['name'] for r in g4['rows']][:3]}")
    page.close()

    # ---- A REJECTED RENAME SAYS SO AND RESTORES THE PREVIOUS NAME.
    page = open_page(browser, port, {DENSITY_KEY: "cozy"})
    page.evaluate("window.__renameShouldFail = true")
    page.dblclick(name_sel)
    page.wait_for_timeout(150)
    page.keyboard.press("ControlOrMeta+a")
    page.keyboard.type("taken_name")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    g5 = page.evaluate("window.__sidebarMeasure()")
    rep.check(any(r["name"] == "cloude_fstest" for r in g5["rows"]),
              "ITEM 66: a FAILED rename restores the previous name",
              f"names={[r['name'] for r in g5['rows']][:3]}")
    rep.check(not any(r["name"] == "taken_name" for r in g5["rows"]),
              "ITEM 66: and the rejected name is nowhere on screen", "")
    # THE EDITOR STAYS OPEN, WITH THE TEXT STILL IN IT. Closing it and
    # only announcing the failure would make the user retype rather than
    # correct, and would be invisible to a check that only reads the live
    # region - the announcement survives either way.
    rep.check(g5["rename"] is not None,
              "ITEM 66: a failed rename leaves the editor OPEN to be corrected",
              f"rename={g5['rename']}")
    if g5["rename"]:
        rep.check(g5["rename"]["value"] == "taken_name",
                  "ITEM 66: with the rejected text still in it, not cleared",
                  f"value={g5['rename']['value']!r}")
        rep.check("rename failed" in g5["rename"]["error"],
                  "ITEM 66: and the reason shown NEXT TO the input, not only announced",
                  f"error={g5['rename']['error']!r}")
    page.close()

    # ---- A ROW THAT CANNOT BE RENAMED OPENS NO EDITOR. Last, because it
    # activates the row and closes the panel.
    page = open_page(browser, port, {DENSITY_KEY: "cozy"})
    g6 = page.evaluate("window.__sidebarMeasure()")
    blocked = [(r, s) for r, s in zip(g6["rows"], g6["renameStates"]) if s != "renameable"]
    row, state = blocked[0]
    page.dblclick(
        f'.session-sidebar-row[data-name="{row["name"]}"] .session-sidebar-row-name')
    page.wait_for_timeout(200)
    g7 = page.evaluate("window.__sidebarMeasure()")
    rep.check(g7["rename"] is None,
              "ITEM 66: a row that cannot be renamed opens NO editor",
              f"state={state}")
    rep.check(bool(g7["live"]),
              "ITEM 66: and it SAYS why rather than doing nothing",
              f"live={g7['live']!r}")
    page.close()
