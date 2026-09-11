"""Collaborators that own one cluster of ``SessionManager``'s state each.

``src/core/session_manager.py`` is a facade: it keeps its public surface
and composes the classes in this package, each of which owns exactly one
mutable cluster. See ``.claude/notes/backend-decomposition-plan.md``.

TWO RULES HOLD FOR EVERY MODULE IN HERE, and both are enforced by
``tests/test_sessions_package_rules.py`` rather than remembered:

1. **Nothing in this package may import ``session_manager``.** The
   dependency arrow points one way, facade to collaborator, which is what
   keeps the function-level imports the god object needs today from
   growing back as a cycle.
2. **No module in here exceeds 500 lines.** The guideline that produced
   the decomposition plan defends the code that fixes it.

THE STATE MOVES, IT NEVER COPIES. A collaborator holds the one and only
copy of its cluster; the facade reaches it through delegation and keeps
no second copy that could drift. Two objects holding one logical state
and kept in sync by hand is the shape of the bug that produced 22
``/sessions/list`` rows for 21 live panes.
"""
