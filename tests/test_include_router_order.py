"""No router may be included before its own handlers are declared.

FastAPI before about 0.141 COPIES a sub-router's routes at the moment
``parent.include_router(sub)`` runs. An include placed above the
``@sub.get`` / ``@sub.post`` decorators therefore copies an empty router,
and every route declared afterwards is silently absent from the app. 1.4.2
shipped exactly that in ``src/api/auth_routes.py``: login answered 404 on
any install whose venv carried FastAPI 0.121.3, while this suite, running
on 0.141.1, which resolves included routers lazily, stayed green.

So the rule is checked STATICALLY, from the source, and never by asking
the installed FastAPI: a runtime route-table check passes on the newer
version whatever the source says, which is how the defect got through.
The route-table test below is the second half, for the old-FastAPI venv.
"""

from __future__ import annotations

import ast
from pathlib import Path

from fastapi import FastAPI

SRC = Path(__file__).resolve().parent.parent / "src"

#: Methods on an APIRouter that register a route when called or used as a
#: decorator.
REGISTERING_METHODS = frozenset(
    {
        "get", "post", "put", "patch", "delete", "head", "options", "trace",
        "api_route", "websocket", "route", "websocket_route",
        "add_api_route", "add_api_websocket_route", "add_route",
        "add_websocket_route",
    }
)


def late_includes(source: str) -> list[tuple[int, str, int]]:
    """Find includes of a module-local router placed above its handlers.

    Args:
        source: The text of one Python module.

    Returns:
        One ``(include_line, router_name, registration_line)`` per include
        whose router gains a route on a LATER line of the same module.
        Only a bare-name router is considered: ``other_module.router`` was
        fully built when its module finished importing.

    Example:
        >>> late_includes("p.include_router(s)\\n@s.get('/x')\\ndef f(): ...\\n")
        [(1, 's', 2)]
    """
    tree = ast.parse(source)
    includes: list[tuple[int, str]] = []
    registrations: dict[str, list[int]] = {}

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        method = node.func.attr
        owner = node.func.value
        if method == "include_router":
            if node.args and isinstance(node.args[0], ast.Name):
                includes.append((node.lineno, node.args[0].id))
        elif method in REGISTERING_METHODS and isinstance(owner, ast.Name):
            registrations.setdefault(owner.id, []).append(node.lineno)

    return [
        (line, name, max(registrations[name]))
        for line, name in includes
        if name in registrations and max(registrations[name]) > line
    ]


def test_no_router_in_src_is_included_before_its_handlers():
    offenders = []
    for path in sorted(SRC.rglob("*.py")):
        for line, name, reg in late_includes(path.read_text()):
            offenders.append(
                f"{path.relative_to(SRC.parent)}:{line}: include_router({name}) "
                f"runs before a {name} route declared on line {reg}"
            )
    assert not offenders, (
        "these includes copy a router before its routes exist, which drops "
        "every later route on FastAPI < 0.141:\n  "
        + "\n  ".join(offenders)
        + "\n\nMove the include below the last handler of that router."
    )


def test_the_detector_flags_the_shape_that_shipped_and_passes_the_fix():
    """Negative control: a detector that finds nothing proves nothing."""
    shipped = (
        "router.include_router(pairing_router)\n"
        "@pairing_router.post('/auth/verify')\n"
        "async def verify(): ...\n"
        "pairing_router.add_api_route('/auth/late', verify)\n"
    )
    fixed = (
        "@pairing_router.post('/auth/verify')\n"
        "async def verify(): ...\n"
        "router.include_router(pairing_router)\n"
        "router.include_router(other_module.router)\n"
    )
    assert late_includes(shipped) == [(1, "pairing_router", 4)]
    assert late_includes(fixed) == []


def test_every_auth_route_is_in_the_assembled_table():
    """The route table as the INSTALLED FastAPI builds it.

    Green on a FastAPI that resolves includes lazily whatever the source
    order, so on its own it proves nothing there; on an older FastAPI it
    is the direct measurement of the 404.
    """
    from src.api.auth_routes import router

    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    # The OpenAPI schema, not ``app.routes``: FastAPI 0.141 keeps an
    # included router as one lazy node there, so only the schema (what
    # /openapi.json serves) flattens to paths on every version.
    paths = set(app.openapi()["paths"])
    expected = {
        "/api/v1/auth/verify",
        "/api/v1/auth/refresh",
        "/api/v1/auth/logout",
        "/api/v1/auth/qr",
        "/api/v1/auth/status",
    }
    assert expected <= paths, f"missing auth routes: {sorted(expected - paths)}"
