"""Every API route the CLIENT actually calls must exist on the server.

WHY THIS FILE EXISTS. A route renamed on the server does not break a
build - it breaks in a browser, at runtime, as a 404 in a console nobody
is reading. Nothing in this repo connected the two sides: the server had
tests for its routes and the client had tests for its behaviour, and the
CONTRACT between them was unasserted. This asserts it, and it asserts it
from the client SOURCE rather than from a hand-maintained list, because a
hand-maintained list is a third thing that can drift from both.

WHAT IT DOES NOT CLAIM. This proves a path is ROUTABLE, nothing more. It
says nothing about whether a call succeeds, and deliberately so: the
finding that prompted it was that ``GET /api/v1/sessions`` 404s on the
deployed server thousands of times a day and that this is CORRECT - the
route exists and answers 404 {"detail": "No active session"} as its
documented negative answer, distinguishable from an absent route's
{"detail": "Not Found"}. Confusing "answers 404" with "does not exist" is
the mistake this file is shaped to avoid making in the other direction.

THREE OUTCOMES. If the client sources cannot be read, or no call sites
can be extracted at all, that is a CANNOT DETERMINE and it FAILS loudly
rather than passing vacuously - a zero-length extraction and a fully
clean contract produce identical output otherwise, which is the false
green this suite has shipped before. ``test_extractor_actually_extracts``
is that positive control.
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_routes_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_routes_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

CLIENT_JS = ROOT / "client" / "js"
#: The svelte client. client/js is no longer the whole client: slice 7
#: deleted client/js/launchpad.js and the home screen now lives here, so
#: a scanner that reads only client/js goes SILENT on the first raw
#: fetch anyone writes in a .ts or .svelte file rather than failing.
WEB_SRC = ROOT / "web" / "src"
API_PREFIX = "/api/v1"

# The extractor must find at least this many distinct call sites. It is a
# floor, not a count: it exists so that a regex that silently stops
# matching (a refactor to a different call helper, a syntax the pattern
# does not cover) fails here instead of turning this whole file into a
# no-op that reports success. Measured at 60+ when written; set well
# under that so ordinary churn does not trip it.
MIN_CALL_SITES = 30


def _normalise(path: str) -> str:
    """Reduce a path to a comparable shape: no query, params as ``{}``.

    A client template ``/sessions/${id}/theme`` and a server declaration
    ``/sessions/{session_name}/theme`` are the same route with different
    parameter names, so both collapse to ``/sessions/{}/theme``.

    One subtlety worth stating, because getting it wrong produced six
    false FAILs on the first run: this client appends its query string as
    an interpolation, ``this.call(`/sessions${q}`)``, so there is no
    literal ``?`` to split on. A parameter always follows a ``/``; an
    interpolation that does NOT follow a ``/`` is a query suffix and is
    dropped rather than treated as a path segment.

    Inputs:
        path (str): a path from either side, possibly with a query string.
    Outputs:
        str: the normalised path.

    Example:
        >>> _normalise("/sessions/${id}/theme?x=1")
        '/sessions/{}/theme'
        >>> _normalise("/sessions${q}")
        '/sessions'
    """
    path = path.split("?", 1)[0]
    path = re.sub(r"\$\{[^}]*\}", "{}", path)
    path = re.sub(r"\{[^}]*\}", "{}", path)
    # Trailing/embedded interpolation not preceded by "/" = query suffix.
    path = re.sub(r"(?<!/)\{\}", "", path)
    return path.rstrip("/") or "/"


def _client_call_sites() -> set[str]:
    """Extract every server path the client source asks for.

    Two syntaxes are covered, which between them are how this client
    addresses the API: ``this.call('<path>')`` inside the APIClient (the
    path is relative to ``/api/v1``), and any literal ``/api/v1/...``
    string or template anywhere under client/js OR web/src (the handful
    of call sites that build a URL and fetch it directly). Test files
    under web/src are skipped: a fixture URL is not a call site.

    A template whose FIRST segment is an interpolation is skipped - the
    path is not knowable statically, so asserting on it would be
    asserting on a guess.

    Inputs:
        None (reads client/js and web/src from disk).
    Outputs:
        set[str]: normalised paths, each already prefixed with /api/v1.
    """
    found: set[str] = set()
    sources = list(CLIENT_JS.rglob("*.js"))
    for pattern in ("*.ts", "*.svelte"):
        sources += [
            p for p in WEB_SRC.rglob(pattern)
            if ".test." not in p.name
        ]
    for js in sorted(sources):
        src = js.read_text(encoding="utf-8", errors="replace")
        # Strip block and line comments so a path mentioned in prose
        # cannot be mistaken for a call. This repo has already shipped a
        # false FAIL from grepping a comment as if it were code.
        src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
        src = re.sub(r"(?m)^\s*//.*$", "", src)

        # `callEnvelope(` as well as `call(`: every archive endpoint goes
        # through the envelope helper, so a pattern matching only `call(`
        # leaves all eleven of them invisible to this contract and the
        # suite stays green while proving nothing about them.
        for m in re.finditer(
                r"""\bthis\.(?:call|callEnvelope)\(\s*['"`](/[^'"`]*)['"`]""", src):
            found.add(_normalise(API_PREFIX + m.group(1)))
        for m in re.finditer(r"""['"`](/api/v1/[^'"`\s]*)['"`]""", src):
            found.add(_normalise(m.group(1)))
        # `'/api/v1/sessions/' + encodeURIComponent(x) + '/theme'` - a
        # concatenated build. Take the literal head and mark the rest as
        # a parameter; the tail after the next literal is recovered by
        # the following literal fragment in the same expression.
        for m in re.finditer(
            r"""['"`](/api/v1/[^'"`\s]*/)['"`]\s*\+[^;]*?\+\s*['"`](/[^'"`\s]*)['"`]""",
            src,
        ):
            found.add(_normalise(m.group(1) + "{}" + m.group(2)))

    # Drop the fragments that the concatenation rule above already
    # superseded (the bare literal head, e.g. '/api/v1/sessions/').
    return {p for p in found if p}


def _server_paths() -> set[str]:
    """Every path the running application will route, normalised.

    Read from the app's own OpenAPI document rather than by walking
    ``app.routes``: this FastAPI version keeps included routers as opaque
    ``_IncludedRouter`` objects instead of flattening them, so a naive
    walk of ``app.routes`` finds 19 paths and none of the API ones. That
    walk would have reported this entire contract as broken.

    Inputs:
        None.
    Outputs:
        set[str]: normalised server paths.
    """
    from src.main import app

    return {_normalise(p) for p in app.openapi()["paths"]}


def test_extractor_actually_extracts() -> None:
    """POSITIVE CONTROL: the extraction found real call sites.

    Without this, a regex that matches nothing makes every other test in
    this file pass by comparing an empty set against anything.
    """
    sites = _client_call_sites()
    assert len(sites) >= MIN_CALL_SITES, (
        f"only {len(sites)} client call sites extracted (floor {MIN_CALL_SITES}). "
        "The extractor is probably no longer matching how this client calls the "
        "API - fix the extractor, do not lower the floor."
    )
    # A known-present anchor, so a regex that matches junk still fails.
    assert "/api/v1/sessions" in sites
    # THE `callEnvelope` HALF OF THE SAME POSITIVE CONTROL. The pattern
    # above was widened from `this.call(` to `this.(call|callEnvelope)(`
    # for the archive endpoints; a pattern change with no matching change
    # to its own positive control is exactly the false green this file
    # exists to prevent. `/archive/hosts` is reachable ONLY through
    # callEnvelope, so this assertion fails if the widening is reverted.
    assert "/api/v1/archive/hosts" in sites, (
        "the extractor found no callEnvelope() call site. Every archive "
        "endpoint goes through that helper, so the contract below is "
        "asserting nothing about eleven routes."
    )


def test_server_route_table_is_readable() -> None:
    """CANNOT DETERMINE guard: the app must expose a usable route set."""
    paths = _server_paths()
    assert len(paths) >= 20, (
        f"only {len(paths)} server paths resolved - the route table could not be "
        "read, so this file can assert nothing. This is a CANNOT DETERMINE, "
        "never a pass."
    )


def test_every_route_the_client_calls_exists_on_the_server() -> None:
    """The contract itself."""
    called = _client_call_sites()
    served = _server_paths()
    missing = sorted(p for p in called if p not in served)
    assert not missing, (
        "the client calls paths the server does not route: "
        + ", ".join(missing)
        + ". Either the route was renamed and the client was not updated, or the "
        "client gained a call site the server never grew."
    )


def test_the_sessions_route_the_404_was_reported_on_is_routable() -> None:
    """The specific path this file was written for.

    ``GET /api/v1/sessions`` 404s constantly on the deployed server and
    that is its documented negative answer, not a missing route. This
    pins the route's existence so a future rename cannot make the two
    indistinguishable.
    """
    from src.main import app

    ops = app.openapi()["paths"].get("/api/v1/sessions")
    assert ops is not None, "GET /api/v1/sessions is no longer routed"
    assert "get" in ops, "/api/v1/sessions no longer accepts GET"


@pytest.mark.parametrize(
    "path",
    ["/api/v1/sessions", "/api/v1/sessions/list", "/api/v1/sessions/attachable"],
)
def test_named_session_routes_stay_routable(path: str) -> None:
    """Guard the three the launchpad's session list is built on."""
    assert _normalise(path) in _server_paths(), f"{path} is no longer routed"


def test_the_web_src_arm_actually_fires(tmp_path, monkeypatch):
    """NEGATIVE CONTROL for the svelte half of the scanner.

    Description: a scanner that reads a tree and finds nothing looks
      exactly like a scanner pointed at the wrong tree, and until slice 7
      this contract only ever read ``client/js``. web/src makes its one
      real API call through the legacy ``window.API``, so the web/src arm
      currently contributes ZERO paths on a clean tree - which is the
      precise condition under which a broken arm is invisible. This plants
      a call in a stand-in web/src and proves the arm reports it, for a
      ``.ts`` and a ``.svelte`` file, so the day someone writes a raw
      fetch in the svelte client this contract fails instead of shrugging.
    Inputs: tmp_path (Path), monkeypatch (pytest fixture).
    Output: None.
    """
    fake = tmp_path / "web-src"
    (fake / "lib").mkdir(parents=True)
    (fake / "lib" / "planted.ts").write_text(
        "export const go = () => fetch('/api/v1/planted/ts/route');\n",
        encoding="utf-8",
    )
    (fake / "lib" / "Planted.svelte").write_text(
        "<script>fetch('/api/v1/planted/svelte/route');</script>\n",
        encoding="utf-8",
    )
    # A test file must NOT count: a fixture URL is not a call site.
    (fake / "lib" / "ignored.test.ts").write_text(
        "it('x', () => fetch('/api/v1/planted/from/a/test'));\n",
        encoding="utf-8",
    )
    # And a path named only in a COMMENT must not count either, which is
    # the failure mode this repo has already shipped once.
    (fake / "lib" / "prose.ts").write_text(
        "// see /api/v1/planted/in/a/comment for why\nexport const x = 1;\n",
        encoding="utf-8",
    )
    monkeypatch.setattr("tests.test_client_called_routes_exist.WEB_SRC", fake)

    found = _client_call_sites()

    assert "/api/v1/planted/ts/route" in found, (
        "the web/src arm did not report a planted .ts call site; it is "
        "pointed at the wrong tree or matching the wrong shape"
    )
    assert "/api/v1/planted/svelte/route" in found, (
        "the web/src arm did not report a planted .svelte call site"
    )
    assert "/api/v1/planted/from/a/test" not in found, (
        "a web/src TEST file was scanned as if it were a call site"
    )
    assert "/api/v1/planted/in/a/comment" not in found, (
        "a path named in a comment was read as a call site"
    )
