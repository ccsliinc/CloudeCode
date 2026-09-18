#!/usr/bin/env python3
"""Read the nav parity page's own report out of a real browser.

WHY A BROWSER AND NOT jsdom. Every number this page produces comes from
`getBoundingClientRect`, `scrollWidth` and `clientWidth` - layout, which
jsdom does not do. A vitest suite asserting the card is 49px tall would
be asserting its own arrangement. So the page is loaded in a real
Chromium at a real width, and this script only reads back the text the
page itself computed.

IT MEASURES THE SERVED PAGE, NOT THE SOURCE TREE. The URL is the one the
owner has open, so a measurement here is a measurement of what he is
looking at. If the dev server is serving a stale build, this reports the
stale build, which is the correct behaviour: the alternative is a number
that agrees with the repository and not with the screen.

Usage:
    venv/bin/python3 web/dev-harness/measure_nav_parity.py [URL]
"""

from __future__ import annotations

import sys

#: The parity page as it is served on the LAN.
DEFAULT_URL = "http://10.0.1.150:5178/nav-parity.html"

#: How long to wait for the page to finish its own async measurement.
#: It mounts three columns, loads 98 rows into each, awaits a painted
#: frame and then measures at three widths, so a short wait reads a
#: half-written report rather than failing.
REPORT_TIMEOUT_MS = 60_000


def main() -> int:
    """Print the parity page's report.

    Output: int - 0 when a report was read, 2 when it was not.
    """
    from playwright.sync_api import sync_playwright

    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    with sync_playwright() as play:
        browser = play.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1400, "height": 1000})
            errors: list = []
            page.on("pageerror", lambda exc: errors.append(str(exc)))
            page.goto(url, wait_until="networkidle")
            # The naming census is the LAST thing the page appends, so
            # waiting for its heading is what proves the whole pass ran.
            # Waiting on a fixed timer would report whatever had been
            # written by then and call it the answer.
            page.wait_for_function(
                "() => (document.body.innerText || '')"
                ".includes('name, scratch or path:')",
                timeout=REPORT_TIMEOUT_MS,
            )
            text = page.inner_text("body")
        finally:
            browser.close()

    if errors:
        print("PAGE ERRORS (the numbers below may be incomplete):")
        for err in errors:
            print(f"  {err}")
    if not text.strip():
        print("REFUSED: the page rendered no report at all")
        return 2
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
