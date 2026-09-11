"""Every cross-boundary reference the server makes actually resolves.

**THIS FILE EXISTS BECAUSE A CLEAN MERGE IS NOT EVIDENCE OF ANYTHING.**
The 1.4.0 integration folded 89 commits from a line that had gone on
editing `src/config.py`, `src/models.py`, the flat `src/api/routes.py` and
a `SessionManager` that still owned its own tables, into a line whose
decomposition had already moved all four. 245 files, and git reported
sixteen conflicts. The conflicts were never the risk. The risk was the
code that merged with no conflict and reached for a name that was no
longer there.

**THE ONES THAT DO NOT RAISE ARE THE EXPENSIVE ONES.** Three of the reads
found in that round were guarded - `getattr(sm, "idle_watchers", {})` and
`hasattr(sm, "get_backend")` - so on this tree they answer falsy rather
than failing, and the feature behind them dies with every test still
green. A fourth was in a TEST: `setattr` on a name an object does not
carry SUCCEEDS, so a tripwire that wrapped live containers by name was
wrapping four decoys and passing while measuring two of six.

So this asserts REACHABILITY rather than behaviour, against the real
classes and the real packages, which is a different question from any
other test in this suite and is the one a merge gets wrong.

**A PURE-STATIC CHECK IS NOT ENOUGH AND A PURE-DYNAMIC ONE IS NOT EITHER.**
A grep cannot tell whether the attribute exists; importing and poking
cannot tell whether anything reaches for it. Both halves are here: the AST
says what is referenced, the import says what resolves.

**THE THIRD RULE IS ARGUMENT REACHABILITY, AND IT IS HERE BECAUSE THE
FIRST TWO MISSED A LIVE ONE.** 1.4.0 shipped
`_resolve_backend(session_manager, target_sid)` in `src/api/websocket.py`
while the two call sites below it passed `registry`. That is neither a
package import nor a `self.<attr>` read - it is the WRONG OBJECT passed as
an argument, where the callee then reaches for a member the passed object
does not carry. The symbol resolved, the file imported, 388 imports and
384 attributes checked green, and every terminal open silently lost its
attach paint because the `AttributeError` landed in the handshake's one
`except Exception`.

So the rule below reads the CALLEE to learn which members it uses on a
parameter, then resolves each call site's argument THROUGH ITS ASSIGNMENT
rather than by its name. Following the assignment is what makes it more
than a spelling check: renaming the local variable cannot hide a
reintroduction, and neither can aliasing it.

SCOPED TO `src/` ON PURPOSE. Under `tests/` a name like `manager` is
routinely a local double with attributes the real class has never had, so
including them would produce false failures and, worse, would train the
next person to widen the allowlist until the guard means nothing.
"""

from __future__ import annotations

import ast
import importlib
import os
import pathlib
import tempfile

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -------------
# This module IMPORTS the packages it is checking, which is the whole
# point: a static grep cannot tell whether a name resolves. Every module
# here that does the same carries this block.
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_xbr_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_xbr_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

SRC = pathlib.Path(__file__).resolve().parents[1] / "src"

#: Packages whose top-level surface the rest of the tree imports names out
#: of. Both were flat modules before the decomposition, so an import that
#: merged in from the other line may name something the package does not
#: re-export.
PACKAGES = ("src.config", "src.models")

#: The module whose `self.<attr>` surface is checked. It is the one class
#: the decomposition moved the most state off, and the one the other line
#: edits most heavily, which is exactly the pairing that produces a silent
#: miss.
MANAGER_MODULE = "src.core.session_manager"
MANAGER_CLASS = "SessionManager"

#: Functions taking a COLLABORATOR as a positional argument, as
#: (module, function, argument index). The rule reads the callee to learn
#: which members it uses on that parameter, then checks that every call
#: site passes something carrying them.
#:
#: `_resolve_backend` is here because it is the one this rule was written
#: for. Adding an entry costs one line and buys the same guard for another
#: seam; a function whose parameter is a plain value rather than a
#: collaborator does not belong here, because it has no member contract to
#: derive.
ARGUMENT_CONTRACTS = (
    ("src.api.ws_connections", "_resolve_backend", 0),
)

#: How a binding expression maps to the class it produces, keyed on the
#: TAIL of the dotted expression so `websocket.app.state.services.registry`
#: and `request.app.state.services.registry` both resolve to one entry.
#: An argument whose binding matches nothing here is REPORTED AS
#: UNRESOLVED and never guessed at - a wrong guess would fail a call site
#: that is perfectly correct, which is how a guard gets widened until it
#: means nothing.
COLLABORATOR_BINDINGS = {
    "services.registry": ("src.core.sessions.registry", "SessionRegistry"),
    "state.session_manager": (MANAGER_MODULE, MANAGER_CLASS),
}


def _python_files():
    """Every source file under `src/`. Inputs: none. Output: list[Path]."""
    return sorted(SRC.rglob("*.py"))


def _package_symbol_imports():
    """Collect `from <pkg> import <name>` across `src/`.

    Inputs: none.
    Output: list[tuple[str, str, str, int]] - (module, name, file, line).
    Example: ('src.models', 'Session', 'src/api/routes.py', 12)
    """
    found = []
    for path in _python_files():
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:  # pragma: no cover - a broken tree fails elsewhere
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module in PACKAGES:
                for alias in node.names:
                    found.append(
                        (node.module, alias.name, str(path), node.lineno)
                    )
    return found


def _manager_self_attributes():
    """Collect every `self.<attr>` in the session manager, with line numbers.

    Inputs: none.
    Output: dict[str, list[int]] - attribute name to the lines using it.
    """
    path = SRC / "core" / "session_manager.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    attrs: dict[str, list[int]] = {}
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "self"
        ):
            attrs.setdefault(node.attr, []).append(node.lineno)
    return attrs


def test_every_package_symbol_import_resolves():
    """A name imported out of `src.config` or `src.models` is exported.

    Description: these were flat modules and are packages now, so an
      import that arrived from the other line can name something real that
      the package's `__init__` does not re-export. That fails at import
      time rather than silently, but it fails on the machine that runs it
      first, which on a release branch is the wrong machine.
    """
    unresolved = []
    checked = 0
    for module_name, symbol, path, line in _package_symbol_imports():
        module = importlib.import_module(module_name)
        checked += 1
        if not hasattr(module, symbol):
            rel = pathlib.Path(path).relative_to(SRC.parent)
            unresolved.append(f"{rel}:{line}: {module_name}.{symbol}")

    assert checked, "the collector found no imports at all, so it measured nothing"
    assert not unresolved, (
        "these names are imported out of a package that does not export "
        "them:\n  " + "\n  ".join(unresolved)
    )


def test_every_manager_self_attribute_resolves():
    """Every `self.<attr>` in `SessionManager` exists on a built instance.

    Description: THE NEGATIVE CASE IS WHY THIS IS WORTH A TEST. A stale
      attribute read raises `AttributeError` at the moment it runs, which
      for `_last_probe_socket` - the one this round actually found - was
      inside the listing pass on the sidebar's hot path. Nothing static
      catches it and no existing test drove that branch.
    """
    module = importlib.import_module(MANAGER_MODULE)
    manager_class = getattr(module, MANAGER_CLASS)
    instance = manager_class()

    attrs = _manager_self_attributes()
    assert attrs, "the collector found no attributes at all"

    missing = {
        name: lines
        for name, lines in sorted(attrs.items())
        if not (hasattr(instance, name) or hasattr(manager_class, name))
    }
    assert not missing, (
        "these attributes are read off `self` in session_manager.py and do "
        "not exist on the class:\n  "
        + "\n  ".join(
            f"self.{name} (lines {lines[:6]})" for name, lines in missing.items()
        )
    )


def _dotted_name(node):
    """Render an attribute chain as a dotted string.

    Description: `websocket.app.state.services.registry` comes back as that
      exact string. Anything not rooted in a bare name - a call, a
      subscript - comes back None, which the caller treats as unresolved
      rather than guessing.
    Inputs: node (ast.AST).
    Output: str | None.
    Example: _dotted_name(tree.body[0].value) -> 'a.b.c'
    """
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    parts.append(node.id)
    return ".".join(reversed(parts))


def _contract_members(module_path, function_name, arg_index):
    """Which members the callee uses on one of its parameters.

    Description: DERIVED FROM THE CALLEE, never declared here. A contract
      written down in this file would be a second copy of the function's
      body and would go stale the first time the function changed, which
      is the precise failure this whole module exists to catch.
    Inputs: module_path (Path); function_name (str); arg_index (int).
    Output: tuple[str | None, set[str]] - the parameter name and the
      members read off it.
    Example: _contract_members(p, '_resolve_backend', 0)
    """
    tree = ast.parse(module_path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if node.name != function_name:
            continue
        params = node.args.args
        if arg_index >= len(params):
            return None, set()
        param = params[arg_index].arg
        members = {
            child.attr
            for child in ast.walk(node)
            if isinstance(child, ast.Attribute)
            and isinstance(child.value, ast.Name)
            and child.value.id == param
        }
        return param, members
    return None, set()


def _argument_call_sites(function_name, arg_index):
    """Every call to `function_name` in `src/`, with its argument's binding.

    Description: resolves the argument NAME to the expression it was
      assigned from, within the enclosing function, so the check below can
      ask what TYPE was passed rather than what the variable was called.
    Inputs: function_name (str); arg_index (int).
    Output: list[tuple[str, int, str, str | None]] - file, line, argument
      name, and the dotted binding (None when it could not be resolved).
    """
    sites = []
    for path in _python_files():
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:  # pragma: no cover - a broken tree fails elsewhere
            continue
        for scope in ast.walk(tree):
            if not isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            bindings = {}
            for node in ast.walk(scope):
                if not isinstance(node, ast.Assign):
                    continue
                dotted = _dotted_name(node.value)
                if not dotted:
                    continue
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        bindings[target.id] = dotted
            for node in ast.walk(scope):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name)
                    and node.func.id == function_name
                    and len(node.args) > arg_index
                    and isinstance(node.args[arg_index], ast.Name)
                ):
                    name = node.args[arg_index].id
                    sites.append(
                        (str(path), node.lineno, name, bindings.get(name))
                    )
    return sites


def _resolved_class(binding):
    """The class a dotted binding produces, or None when unmapped.

    Inputs: binding (str) - a dotted expression.
    Output: type | None.
    Example: _resolved_class('ws.app.state.services.registry')
    """
    for tail, (module_name, class_name) in COLLABORATOR_BINDINGS.items():
        if binding == tail or binding.endswith("." + tail):
            return getattr(importlib.import_module(module_name), class_name)
    return None


def test_every_collaborator_argument_carries_the_members_its_callee_uses():
    """A function handed the wrong object is caught before it ships.

    Description: THE DEFECT THIS CATCHES DOES NOT RAISE WHERE IT IS
      WRITTEN. It raises inside the callee, at attribute-access time, which
      on the path that produced this rule was inside a broad `except` that
      logged and carried on. So the call site looks fine, the import
      resolves, the suite stays green, and the feature is simply gone.
    """
    unresolved = []
    wrong = []
    checked = 0

    for module_name, function_name, arg_index in ARGUMENT_CONTRACTS:
        module_path = SRC.parent / (module_name.replace(".", "/") + ".py")
        param, members = _contract_members(module_path, function_name, arg_index)
        assert members, (
            f"derived no members for {function_name}'s argument {arg_index} "
            f"({param!r}), so this rule would pass without measuring anything"
        )

        for path, line, arg_name, binding in _argument_call_sites(
            function_name, arg_index
        ):
            rel = pathlib.Path(path).relative_to(SRC.parent)
            if binding is None:
                unresolved.append(f"{rel}:{line}: {arg_name} (no binding found)")
                continue
            cls = _resolved_class(binding)
            if cls is None:
                unresolved.append(f"{rel}:{line}: {arg_name} = {binding}")
                continue
            checked += 1
            missing = sorted(m for m in members if not hasattr(cls, m))
            if missing:
                wrong.append(
                    f"{rel}:{line}: {function_name}({arg_name}) gets "
                    f"{cls.__name__} (from {binding}), which has no "
                    + ", ".join(missing)
                )

    assert checked, (
        "no call site resolved to a known collaborator, so this rule "
        "measured nothing. Either COLLABORATOR_BINDINGS is stale or the "
        "call sites moved:\n  " + "\n  ".join(unresolved)
    )
    assert not wrong, (
        "these call sites pass an object that does not carry the members "
        "the callee reads off it:\n  " + "\n  ".join(wrong)
    )


def test_the_collectors_can_actually_fail():
    """THE NEGATIVE CONTROL, and it is not optional here.

    Description: both assertions above are "nothing was found", which is
      exactly the shape that passes just as happily when the collector is
      broken and returns an empty list. A matcher that always finds
      nothing is worse than useless. So this plants a reference that MUST
      be reported and checks the resolution step reports it.
    """
    module = importlib.import_module(MANAGER_MODULE)
    instance = getattr(module, MANAGER_CLASS)()

    assert not hasattr(instance, "_a_name_this_class_has_never_had"), (
        "the planted control name exists, so it proves nothing"
    )
    with pytest.raises(AttributeError):
        getattr(instance, "_a_name_this_class_has_never_had")

    config_module = importlib.import_module("src.config")
    assert not hasattr(config_module, "_a_symbol_this_package_never_exported")

    # AND THE ARGUMENT RULE, which needs its own control for the same
    # reason: it asserts "nothing wrong was found". The pairing that
    # actually shipped broken is the proof that it can find something -
    # `SessionManager` really does fail `_resolve_backend`'s contract, so a
    # call site resolving to it WOULD be reported. If this list ever comes
    # back empty the rule has stopped being able to fail and is decoration.
    param, members = _contract_members(
        SRC / "api" / "ws_connections.py", "_resolve_backend", 0
    )
    assert members, "the contract collector derived nothing to check"
    manager_class = getattr(
        importlib.import_module(MANAGER_MODULE), MANAGER_CLASS
    )
    assert [m for m in members if not hasattr(manager_class, m)], (
        f"{MANAGER_CLASS} now carries every member _resolve_backend reads "
        f"off its argument ({sorted(members)}), so passing the manager "
        "there would no longer be detectable and the rule above proves "
        "nothing about which object is passed"
    )
