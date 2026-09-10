"""``SessionManager`` forwards to none of the five shipped collaborators.

Slice S1 of ``.claude/notes/backend-decomposition-plan.md``, and the
machine-checked half of its Rule B:

> A slice is not done until nothing outside the collaborator's own module
> and its own tests calls the manager for that cluster. The slice DELETES
> the forwarders it would otherwise have written. A slice that leaves a
> forwarder behind has not finished; it has moved the code and kept the
> weight.

**WHY THIS IS A TEST AND NOT A CONVENTION.** Version 1 of the plan kept
the facade permanently, so each extraction slice moved a 20-line body out
and left a documented forwarder behind. Measured on the branch head
before this slice: 23 pure forwarding members costing 291 lines, an
average of 12.7 lines to forward one call. Two of the five slices GREW
the file they were shrinking. Nothing failed when that happened, which is
exactly why it kept happening.

The check is an AST walk rather than a grep, because a forwarder is a
SHAPE (one statement, whose whole job is to reach a collaborator) and not
a string. It deliberately covers only the five clusters that have
shipped: six further forwarders point at ``_hook_tokens``,
``_unread_store``, ``_activity_tracker``, the two notification handles
and ``_tmux_socket_name``, and those belong to slices that have not run
yet. Adding them here would fail the build for work nobody has done,
which is a countdown rather than an invariant. THE LIST GROWS WITH THE
SLICES, one entry per slice, and S9 is where it stops mattering because
the class is gone.

Run with:
    ./venv/bin/python3 -m pytest tests/test_no_cluster_forwarders.py -v
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MANAGER = ROOT / "src" / "core" / "session_manager.py"

#: The private handles whose clusters have shipped. A member of
#: ``SessionManager`` whose entire body reaches one of these is a
#: forwarder and must not exist.
SHIPPED_COLLABORATORS = {
    "_probe_health",
    "_theme_store",
    "_toast_inbox",
    "_registry",
    "_sidecars",
}

#: Names that were forwarders before this slice, kept so a REVIVAL is
#: caught by name as well as by shape. A future member called
#: ``get_toasts`` that did real work would be a different thing and would
#: pass the shape check; it would still be the wrong place for it.
DELETED_FORWARDERS = {
    "pinned_themes",
    "_theme_accent_cache",
    "_pending_toasts",
    "_pending_startup_toasts",
    "log_buffers",
    "command_counts",
    "idle_watchers",
    "adopt_fifo_offsets",
    "pending_terminal_commands",
    "_load_pinned_themes",
    "_save_pinned_themes",
    "get_pinned_theme",
    "discard_pinned_theme",
    "get_project_theme",
    "set_project_theme",
    "resolve_project_theme",
    "_get_theme_accent_color",
    "_prune_toasts",
    "ack_toast",
    "get_toasts",
    "last_probe_health",
}


def _manager_class() -> ast.ClassDef:
    """The parsed ``SessionManager`` class body.

    Description: parsed from source rather than imported, so this runs
      with no application state and reports on the FILE, which is the
      thing the line-count claim is about.
    Inputs: none.
    Output: ast.ClassDef.
    Example: _manager_class().name  # 'SessionManager'
    """
    tree = ast.parse(MANAGER.read_text(encoding="utf-8"), filename=str(MANAGER))
    return next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "SessionManager"
    )


def _self_attribute_root(value: ast.expr) -> str | None:
    """The ``self.<name>`` a value expression ultimately hangs off.

    Description: walks the attribute chain down to its base and answers
      the FIRST attribute after ``self``, so ``self._theme_store.get_pin``
      answers ``_theme_store``. Anything not rooted at ``self`` answers
      None.
    Inputs: value (ast.expr).
    Output: str | None.
    Example: _self_attribute_root(node)  # '_toast_inbox'
    """
    chain: list[str] = []
    while isinstance(value, ast.Attribute):
        chain.append(value.attr)
        value = value.value
    if isinstance(value, ast.Name) and value.id == "self" and chain:
        return chain[-1]
    return None


def _forwarders() -> list[tuple[str, str, int]]:
    """Every member of ``SessionManager`` that is a pure forwarder.

    Description: a member qualifies when, after its docstring is set
      aside, its body is EXACTLY ONE statement that returns from, calls,
      or assigns to a shipped collaborator. Property setters count: their
      body is an assignment, not a return, which is how the first count
      of these missed two of them.
    Inputs: none.
    Output: list of (member name, collaborator, line count).
    Example: _forwarders()  # []
    """
    found: list[tuple[str, str, int]] = []
    for node in _manager_class().body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = list(node.body)
        if (
            body
            and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)
        ):
            body = body[1:]
        if len(body) != 1:
            continue
        statement = body[0]
        if isinstance(statement, ast.Return) and statement.value is not None:
            value: ast.expr = statement.value
        elif isinstance(statement, ast.Expr):
            value = statement.value
        elif isinstance(statement, ast.Assign) and len(statement.targets) == 1:
            value = statement.targets[0]
        else:
            continue
        target = value.func if isinstance(value, ast.Call) else value
        root = _self_attribute_root(target)
        if root in SHIPPED_COLLABORATORS:
            start = node.lineno
            if node.decorator_list:
                start = min(d.lineno for d in node.decorator_list)
            found.append((node.name, root, node.end_lineno - start + 1))
    return found


def test_the_manager_class_is_still_parsable_and_present():
    """THE GUARD ON THE OTHER TWO.

    Description: both tests below assert that a list is EMPTY, and an
      empty list is also what a renamed file, a moved class or a parse
      that found nothing would produce. Without this, deleting
      ``session_manager.py`` outright would read as perfect compliance.
    """
    cls = _manager_class()
    members = [n.name for n in cls.body if isinstance(n, ast.FunctionDef)]

    assert len(members) > 50, (
        f"SessionManager holds only {len(members)} methods; the walk below "
        "may be reporting on the wrong thing"
    )


def test_no_member_forwards_to_a_shipped_collaborator():
    """RULE B. A forwarder is a slice that has not finished."""
    offenders = _forwarders()

    assert offenders == [], (
        "SessionManager forwards to a shipped collaborator: "
        + ", ".join(f"{name} -> self.{root} ({n} lines)" for name, root, n in offenders)
        + ". Point the caller at the collaborator instead."
    )


@pytest.mark.parametrize("name", sorted(DELETED_FORWARDERS))
def test_a_deleted_forwarder_is_not_revived(name: str):
    """The 23 names that went in S1 do not come back on this class.

    Description: by NAME, alongside the shape check above, because the two
      catch different revivals. A member re-added with a line of real work
      in it passes the shape check and is still the wrong place for it:
      the caller that wants that behaviour should be holding the
      collaborator.
    Inputs: name (str) - one deleted member name.
    Output: None.
    """
    members = {
        node.name
        for node in _manager_class().body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }

    assert name not in members, (
        f"SessionManager.{name} is back; it was deleted in S1 and its "
        "callers hold the collaborator now"
    )
