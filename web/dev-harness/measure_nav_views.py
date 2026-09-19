#!/usr/bin/env python3
"""Read the per-view project-name report out of a real browser.

WHY A BROWSER AND NOT jsdom. The page reports card HEIGHTS off
``getBoundingClientRect``, which is layout, and jsdom does not lay out.
A vitest suite asserting 49px would be asserting its own arrangement.
The vitest suite beside this one asserts the TEXT, which jsdom can
answer for; this one is what confirms the geometry did not move.

IT MEASURES THE SERVED PAGE, NOT THE SOURCE TREE. The URL is the one the
owner has open, so what this prints is what that server is serving. If
the dev server is stale, this reports the stale build, which is correct:
a number that agrees with the repository and not with the screen is the
failure mode this whole area keeps producing.

Usage:
    venv/bin/python3 web/dev-harness/measure_nav_views.py [URL]
"""

from __future__ import annotations

import sys

#: The page as it is served on the LAN.
DEFAULT_URL = "http://10.0.1.150:5178/nav-views.html"

#: The page mounts three rails, loads 100 rows into each, expands the
#: by-machine tree to its project level and awaits a painted frame, so a
#: short wait reads a half-written report rather than failing.
REPORT_TIMEOUT_MS = 90_000


def main() -> int:
    """Print the page's report.

    Output: int - 0 when a report was read, 2 when it was not.
    """
    from playwright.sync_api import sync_playwright

    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1400, "height": 1200})
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(url, wait_until="load")
            # The page stamps data-state itself, so this waits on the
            # page's OWN claim to be finished rather than on a sleep.
            page.wait_for_selector(
                '#nav-views-report[data-state="ready"], '
                '#nav-views-report[data-state="no-capture"]',
                timeout=REPORT_TIMEOUT_MS,
            )
            state = page.get_attribute("#nav-views-report", "data-state")
            print(page.inner_text("#nav-views-report"))
            if errors:
                print("\nPAGE ERRORS (the report above may be incomplete):")
                for e in errors:
                    print("  ", e)
            # A missing capture is NOT a pass. It renders as every row
            # showing a slug, which is the exact wrong conclusion.
            return 0 if state == "ready" and not errors else 2
        finally:
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
