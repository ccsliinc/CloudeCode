"""The two rules that hold for every module under ``src/core/sessions/``.

Both come from ``.claude/notes/backend-decomposition-plan.md`` section 9,
and both are enforced here rather than remembered, because the guideline
that produced the decomposition plan should defend the code that fixes
it.

1. **Nothing in the package may import ``session_manager``.** The
   dependency arrow points one way, facade to collaborator. A cycle would
   reintroduce exactly the function-level imports the god object needs
   today, and would do it quietly - Python resolves a late import fine,
   so the design would rot with a green suite.
2. **No module in the package exceeds 500 lines.** The file this package
   exists to shrink is 8,000-odd lines because nothing ever failed when
   it grew.

Run with:
    ./venv/bin/python3 -m pytest tests/test_sessions_package_rules.py -v
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "src" / "core" / "sessions"

#: The guideline from CLAUDE.md's "How we work here", as a number.
MAX_LINES = 500

#: The module a collaborator may never depend on, in either spelling.
FORBIDDEN_IMPORT = "session_manager"


def _package_modules() -> list[Path]:
    """Every Python module in the collaborator package.

    Description: sorted so a failure message names files in a stable
      order. Empty is not a pass - see the guard test below.
    Inputs: none.
    Output: list[Path].
    Example: _package_modules()[0].name  # '__init__.py'
    """
    return sorted(PACKAGE.rglob("*.py"))


def test_the_package_exists_and_holds_modules():
    """THE GUARD ON THE OTHER TWO TESTS.

    ``rglob`` over a missing or renamed directory returns an empty list,
    and a parametrised test over an empty list PASSES. Without this, a
    package that had been moved would look perfectly compliant.
    """
    assert PACKAGE.is_dir(), f"{PACKAGE} is missing"
    modules = _package_modules()
    assert modules, "the package holds no modules, so the rules below tested nothing"


@pytest.mark.parametrize("module", _package_modules(), ids=lambda p: p.name)
def test_no_collaborator_imports_the_session_manager(module: Path):
    """RULE 1. The dependency arrow points one way.

    Parsed rather than grepped, so a mention inside a docstring or a
    comment - and both files carry several - is not mistaken for a
    dependency. Only a real ``import`` statement counts.
    """
    tree = ast.parse(module.read_text(encoding="utf-8"), filename=str(module))

    offenders: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            offenders += [
                a.name for a in node.names if FORBIDDEN_IMPORT in a.name
            ]
        elif isinstance(node, ast.ImportFrom):
            if node.module and FORBIDDEN_IMPORT in node.module:
                offenders.append(node.module)

    assert offenders == [], (
        f"{module.name} imports {offenders}; nothing under src/core/sessions/ "
        "may depend on the facade"
    )


@pytest.mark.parametrize("module", _package_modules(), ids=lambda p: p.name)
def test_no_collaborator_exceeds_the_line_guideline(module: Path):
    """RULE 2. More files are better than longer files."""
    lines = len(module.read_text(encoding="utf-8").splitlines())

    assert lines <= MAX_LINES, (
        f"{module.name} is {lines} lines, over the {MAX_LINES}-line guideline; "
        "split it rather than raising the number"
    )
