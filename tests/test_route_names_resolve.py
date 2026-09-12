"""Every route handler's global names must actually resolve.

THE DEFECT. ``run_in_threadpool`` was imported inside two individual
handlers rather than at module scope. Two NEW handlers - the fork endpoint
and the LM Studio model list - used it anyway. Python does not complain at
import time about a name a function will look up later, so both modules
loaded fine, both routes registered fine, and both raised
``NameError: name 'run_in_threadpool' is not defined`` the first time
anyone called them. FastAPI turns that into a bare 500 with no body.

WHY IT COST SO MUCH. A 500 with no detail is unhelpable, so the failure
looked like it could be anything: a database problem, a tmux problem, a
permissions problem. It was a missing import, and the endpoint could not
say so. This checks the class rather than the instance.
"""

from __future__ import annotations

import ast
import builtins
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DEFAULT_WORKING_DIR", "/tmp")
os.environ.setdefault("LOG_DIRECTORY", "/tmp")
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
import importlib

import pytest

#: Every module under ``src/api/`` that declares an ``APIRouter``. It is
#: DISCOVERED, not listed: slice S6 split the flat 4,397-line
#: ``routes.py`` into a sibling per resource, and a hand-maintained list
#: would quietly stop covering the next one somebody adds. That is the
#: same defect this file exists to catch, one level up.
def _route_modules() -> list[str]:
    """Import names of every ``src/api`` module that declares a router.

    Inputs: none. Output: sorted list of dotted module names.
    Example: ``["src.api.agent_wrappers_routes", ...]``.
    """
    found = []
    for path in sorted((ROOT / "src" / "api").glob("*.py")):
        if path.name == "__init__.py":
            continue
        text = path.read_text()
        if "= APIRouter(" not in text:
            continue
        found.append(f"src.api.{path.stem}")
    return found


ROUTE_MODULES = _route_modules()

# A discovery that finds nothing passes every parametrised test below
# without running one of them, which is the shape of a guard that has
# quietly stopped guarding.
assert len(ROUTE_MODULES) >= 20, ROUTE_MODULES


def _locally_bound(fn: ast.AST) -> set:
    """Names bound anywhere inside a function: params, assignments, imports."""
    bound = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            bound.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                bound.add((alias.asname or alias.name).split(".")[0])
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            bound.add(node.name)
            for arg in list(node.args.args) + list(node.args.kwonlyargs):
                bound.add(arg.arg)
            if node.args.vararg:
                bound.add(node.args.vararg.arg)
            if node.args.kwarg:
                bound.add(node.args.kwarg.arg)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            bound.add(node.name)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if isinstance(item.optional_vars, ast.Name):
                    bound.add(item.optional_vars.id)
        elif isinstance(node, ast.Lambda):
            # A lambda's parameters are bindings too. Missing these
            # reported `sorted(..., key=lambda p: p.name)` as an
            # unresolved `p`, which is the check being wrong about
            # correct code - the exact false-positive direction that
            # makes a structural test get deleted instead of trusted.
            for arg in list(node.args.args) + list(node.args.kwonlyargs):
                bound.add(arg.arg)
            if node.args.vararg:
                bound.add(node.args.vararg.arg)
            if node.args.kwarg:
                bound.add(node.args.kwarg.arg)
        elif isinstance(node, ast.comprehension):
            if isinstance(node.target, ast.Name):
                bound.add(node.target.id)
    return bound


@pytest.mark.parametrize("module_name", ROUTE_MODULES)
def test_every_route_handler_resolves_its_helper_names(module_name):
    """A name a handler will look up at CALL time must exist somewhere.

    Checked against the module's real namespace, plus builtins, plus what
    the function binds itself, plus what its ENCLOSING functions bind - a
    nested helper legitimately closes over its parent's imports and
    locals, and a check that ignores that reports a wall of false
    positives (this one did, first time).

    That is exactly the lookup Python performs, so a name that fails here
    fails in production - as run_in_threadpool did, in two routes, as a
    bare 500 with no body.
    """
    routes = importlib.import_module(module_name)
    tree = ast.parse(Path(routes.__file__).read_text())
    module_names = set(vars(routes)) | set(dir(builtins))
    offenders = []

    def walk(node, enclosing):
        """Recurse, carrying the accumulated visible bindings."""
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            visible = enclosing | _locally_bound(node)
            for child in node.body:
                walk(child, visible)
            for inner in ast.walk(node):
                if not (isinstance(inner, ast.Name) and isinstance(inner.ctx, ast.Load)):
                    continue
                if inner.id in visible or inner.id in module_names:
                    continue
                offenders.append(f"{node.name}:{inner.lineno} -> {inner.id}")
            return
        for child in ast.iter_child_nodes(node):
            walk(child, enclosing)

    walk(tree, set())

    assert not offenders, (
        f"{module_name}: route handlers reference names that resolve "
        "nowhere; each is a NameError and a bare 500 the first time it is "
        f"called: {sorted(set(offenders))[:10]}"
    )


@pytest.mark.parametrize("module_name", ROUTE_MODULES)
def test_run_in_threadpool_is_available_at_module_scope(module_name):
    """The specific regression, named, in whichever module still uses it.

    It used to be imported inside individual handlers, which is why a new
    handler could use it and fail only when called. After slice S6 the
    handlers live in siblings, so the check follows the USE: a module that
    mentions the name anywhere must bind it at module scope.
    """
    routes = importlib.import_module(module_name)
    source = Path(routes.__file__).read_text()
    if "run_in_threadpool" not in source:
        pytest.skip(f"{module_name} does not use run_in_threadpool")
    assert hasattr(routes, "run_in_threadpool"), (
        f"{module_name}: run_in_threadpool is not at module scope; a "
        "handler that uses it without its own local import will NameError "
        "at call time"
    )
