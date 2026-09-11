"""``real_tmux`` marker derivation: a module importing only ``derive_test_socket``.

Covers the hole in ``tests/conftest.py``'s ``_SOCKET_GUARD_NAMES``: a
module that does ``from tests.socket_guard import derive_test_socket``
and nothing else from that module binds no OTHER name the derivation
recognised, and requests no ``tmux_test_socket`` fixture, so it escaped
the ``real_tmux`` marker entirely and rode along in the fast
``-m "not real_tmux"`` loop despite driving a real throwaway tmux server.
``tests/test_recreate_gate_real_tmux.py`` is exactly that shape.

Runs pytest as a REAL subprocess against the shipped ``tests/conftest.py``
rather than importing its internals, so this proves the marker a plain
``pytest -m real_tmux`` invocation actually applies - the same thing a
developer or CI would run - not an implementation detail of how it is
derived.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _collected_node_ids(marker_expr: str, target: str) -> set[str]:
    """Node ids ``pytest --collect-only -m <marker_expr> <target>`` selects.

    Inputs:
        marker_expr: a ``-m`` marker expression, e.g. ``"real_tmux"``.
        target: a single test file path, relative to the repo root.
    Output: set[str] - one entry per selected test node id. Empty when
        the marker expression selects nothing in that file.
    """
    proc = subprocess.run(
        [
            sys.executable, "-m", "pytest", "-q", "-p", "no:randomly",
            "--collect-only", "-m", marker_expr, target,
        ],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=120,
    )
    return {
        line.strip()
        for line in proc.stdout.splitlines()
        if "::" in line
    }


def test_recreate_gate_real_tmux_carries_the_marker():
    """The module the audit found escaping is selected by ``-m real_tmux``.

    Before the fix, ``_SOCKET_GUARD_NAMES`` had no entry for
    ``derive_test_socket`` and this module requests no
    ``tmux_test_socket`` fixture, so this assertion failed (empty set).
    """
    ids = _collected_node_ids(
        "real_tmux", "tests/test_recreate_gate_real_tmux.py"
    )
    assert ids, (
        "test_recreate_gate_real_tmux.py should carry the real_tmux "
        "marker - it drives a real tmux server via derive_test_socket"
    )


def test_a_known_fast_test_does_not_carry_the_marker():
    """Negative control for the marker's OTHER failure mode: over-broad.

    ``tests/test_project_theme.py`` touches no tmux socket at all (see
    its own module docstring - it is a pure filesystem + FastAPI test).
    A fix that marked every test ``real_tmux`` - or every test in this
    directory - would pass the assertion above and be caught here
    instead: this must stay empty.
    """
    ids = _collected_node_ids("real_tmux", "tests/test_project_theme.py")
    assert ids == set(), (
        "test_project_theme.py drives no real tmux and must not carry "
        f"the real_tmux marker; got: {ids}"
    )
