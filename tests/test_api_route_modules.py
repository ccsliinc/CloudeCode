"""The rules that hold for every route module under ``src/api/``.

Decomposition slice S6 split the flat 4,397-line ``src/api/routes.py`` into
one sibling per resource and left the aggregator behind. Three things have
to stay true afterwards, and none of them is the kind of thing a handler
test notices.

1. **Every sibling that declares a router is INCLUDED.** A module can be
   written, imported, tested and still serve nothing, because the only
   thing that mounts it is one line in the aggregator. Dropping that line
   raises nowhere: the routes simply stop existing and every request to
   them 404s. This is the failure the aggregator introduced and it did not
   exist while the file was flat.

2. **No sibling imports the aggregator.** The arrow points one way. A
   cycle resolves fine at runtime in Python, so the design would rot with
   a green suite.

3. **No route module exceeds 500 lines.** The file this split exists to
   shrink reached 4,397 because nothing ever failed when it grew. The one
   ruled exception in this tree is ``src/config/settings.py`` (see
   ``docs/DECISIONS.md``) and it is not in this package.

Run with:
    ./venv/bin/python3 -m pytest tests/test_api_route_modules.py -v
"""

from __future__ import annotations

import ast
import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("CLOUDE_STATE_DIR", tempfile.mkdtemp(prefix="cc_api_rules_"))
os.environ.setdefault("CLOUDE_TEST_MODE", "1")
os.environ.setdefault("DEFAULT_WORKING_DIR", "/tmp")
os.environ.setdefault("LOG_DIRECTORY", "/tmp")
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

API = ROOT / "src" / "api"

#: The guideline from CLAUDE.md's "How we work here", as a number.
MAX_LINES = 500

#: Files that were ALREADY over the guideline when slice S6 split the two
#: route monoliths, with their size at that moment. They are registered
#: rather than skipped, so they stay visible and so a file that GROWS past
#: its registered size fails: a register that tolerates any number is a
#: rule that has been deleted with extra steps. Neither is in this slice's
#: lane and neither is the ruled ``src/config/settings.py`` exception,
#: which lives in a different package (see docs/DECISIONS.md).
PRE_EXISTING_OVER_LIMIT: dict[str, int] = {
    "recreate_routes.py": 582,
    "websocket.py": 675,
}

#: Routers that ``src/main.py`` mounts only when the message archive is
#: enabled. Named with their CONDITION, because "not mounted" is a
#: different answer from "not mounted here" and only one of them is a
#: defect. ``tests/conftest.py`` sets ``CLOUDE_MESSAGE_ARCHIVE=1``, so
#: under pytest they ARE mounted and the assertion below still runs; this
#: register exists so a run with the flag off reports honestly rather
#: than failing.
ARCHIVE_GATED: frozenset[str] = frozenset({
    "corpus_routes.py",
    "archive_routes.py",
    "archive_overlay_routes.py",
    "archive_export_routes.py",
    "archive_messages_routes.py",
    "archive_search_routes.py",
})

#: How many routes the aggregated ``src.api.routes`` router carried when
#: the split shipped, measured against the flat module it replaced. It is
#: a FLOOR rather than an equality so that adding a route does not fail
#: this file, while losing the whole of one sibling's include does.
AGGREGATED_ROUTE_FLOOR = 51


def _api_modules() -> list[Path]:
    """Every module under ``src/api/``, sorted.

    Inputs: none. Output: list[Path]. Empty is not a pass; see the guard.
    """
    return sorted(p for p in API.glob("*.py") if p.name != "__init__.py")


def _router_modules() -> list[Path]:
    """Every ``src/api`` module that constructs an ``APIRouter``.

    Inputs: none.
    Output: list[Path].
    Example: ``[.../agent_wrappers_routes.py, ...]``.
    """
    return [p for p in _api_modules() if "= APIRouter(" in p.read_text()]


def test_the_discovery_finds_something():
    """A rule applied to an empty set passes without checking anything."""
    assert len(_api_modules()) >= 30, _api_modules()
    assert len(_router_modules()) >= 25, _router_modules()


@pytest.mark.parametrize("path", _api_modules(), ids=lambda p: p.name)
def test_no_route_module_exceeds_the_line_guideline(path: Path):
    """500 lines, per module, enforced rather than remembered."""
    count = len(path.read_text().splitlines())
    registered = PRE_EXISTING_OVER_LIMIT.get(path.name)
    if registered is not None:
        assert count <= registered, (
            f"{path.name} is {count} lines, up from the {registered} it was "
            "when it was registered as a pre-existing exception. A file on "
            "that register may shrink or hold; it may not grow."
        )
        return
    assert count <= MAX_LINES, (
        f"{path.relative_to(ROOT)} is {count} lines, over the {MAX_LINES} "
        "guideline. Split it by concern; the flat routes.py reached 4,397 "
        "because nothing ever failed when it grew."
    )


@pytest.mark.parametrize("path", _router_modules(), ids=lambda p: p.name)
def test_no_sibling_imports_the_aggregator(path: Path):
    """The dependency arrow points aggregator to sibling, never back."""
    if path.name == "routes.py":
        pytest.skip("routes.py IS the aggregator")
    tree = ast.parse(path.read_text())
    offenders = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "src.api.routes":
            offenders.append(node.lineno)
        elif isinstance(node, ast.ImportFrom) and node.module == "src.api":
            offenders.extend(
                node.lineno for a in node.names if a.name == "routes"
            )
        elif isinstance(node, ast.Import):
            offenders.extend(
                node.lineno for a in node.names if a.name == "src.api.routes"
            )
    assert not offenders, (
        f"{path.name} imports the aggregator at line(s) {offenders}. A cycle "
        "resolves fine at runtime, which is why it has to fail here instead."
    )


def _flatten(router) -> list:
    """Every real route under a router, in registration order.

    Description: fastapi 0.141 wraps an included router in a lazy
      ``_IncludedRouter`` that keeps the original on ``original_router``,
      so an assembled table has to be WALKED rather than read.
    Inputs: a router or the application.
    Output: list of route objects.
    """
    out = []
    for route in getattr(router, "routes", []) or []:
        inner = getattr(route, "original_router", None)
        if inner is not None:
            out.extend(_flatten(inner))
        else:
            out.append(route)
    return out


def _endpoint_names(router) -> set[str]:
    """The ``__name__`` of every endpoint reachable under a router.

    Inputs: a router or the application.
    Output: set[str].
    Example: ``"list_themes" in _endpoint_names(app)``.
    """
    names: set[str] = set()
    for route in _flatten(router):
        endpoint = getattr(route, "endpoint", None)
        if endpoint is not None:
            names.add(endpoint.__name__)
    return names


def _application_endpoints() -> set[str]:
    """Every endpoint the ASSEMBLED application actually serves.

    Description: the real ``src.main.app``, not the one router this
      package's aggregator owns. That distinction is the whole point of
      the test below: a module can be mounted by the aggregator, by
      ``src/main.py`` directly, or by another sibling's router, and only
      the application knows about all three.
    Inputs: none.
    Output: set[str].
    """
    from src.main import app

    return _endpoint_names(app)


def test_the_aggregator_actually_serves_what_it_assembles():
    """The route table is not smaller than the one the split replaced.

    A missing ``include_router`` line raises nowhere - the sibling still
    imports, still declares its routes, and simply serves none of them, so
    every request to it 404s. Nothing else in this suite notices a whole
    resource going missing.
    """
    import src.api.routes as routes

    total = 0

    def count(router) -> None:
        nonlocal total
        for route in router.routes:
            inner = getattr(route, "original_router", None)
            if inner is not None:
                count(inner)
            else:
                total += 1

    count(routes.router)
    assert total >= AGGREGATED_ROUTE_FLOOR, (
        f"the aggregated router serves {total} routes, fewer than the "
        f"{AGGREGATED_ROUTE_FLOOR} the flat module did. An include_router "
        "line was dropped, and a dropped include is a silent 404 for an "
        "entire resource."
    )


@pytest.mark.parametrize(
    "path",
    [p for p in _router_modules() if p.name != "routes.py"],
    ids=lambda p: p.name,
)
def test_every_router_a_sibling_declares_reaches_the_application(path: Path):
    """A declared router that nothing mounts is a resource nobody can reach.

    ASSERTED AGAINST THE ASSEMBLED APPLICATION, not against this
    package's aggregator. A sibling reaches the app three ways - through
    ``src/api/routes.py``, mounted directly by ``src/main.py``, or through
    another sibling's router such as ``auth_routes`` or ``archive_routes``
    - and only the application knows about all three.

    THIS USED TO SKIP FOR 22 OF THE 46 MODULES, and a skip is a test that
    does not run. The first version inferred "must be mounted elsewhere"
    from a module having no routes in the aggregator, which is EXACTLY
    what a deleted include looks like; that was caught by mutation and
    replaced with an explicit register. The register was still the wrong
    shape: it turned "I decided not to check this one" into 22 silent
    non-assertions covering, among others, every archive route and the
    entire auth side. Checking the application instead needs no register
    and no exemption, because every legitimate mounting path ends there.

    Checked by ENDPOINT NAME rather than by reading ``src/main.py``'s
    source, because a file naming a module proves it imported it, not
    that it served its routes.
    """
    import importlib

    module = importlib.import_module(f"src.api.{path.stem}")
    declared: set[str] = set()
    for attr in vars(module).values():
        if not hasattr(attr, "include_router") or not hasattr(attr, "routes"):
            continue
        declared |= _endpoint_names(attr)
    if not declared:
        pytest.skip(f"{path.name} declares a router with no routes on it")

    served = _application_endpoints()
    missing = sorted(declared - served)
    if missing and path.name in ARCHIVE_GATED:
        from src.core.message_archive_flag import resolve as resolve_archive

        if not resolve_archive().enabled:
            pytest.skip(
                f"{path.name} is mounted only when the message archive is "
                "enabled, and it is off in this run"
            )
    assert not missing, (
        f"{path.name} declares {missing} but the assembled application "
        "serves none of them: an include_router line is missing and those "
        "routes 404 for every caller."
    )
