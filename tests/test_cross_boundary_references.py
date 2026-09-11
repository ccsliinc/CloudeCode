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
