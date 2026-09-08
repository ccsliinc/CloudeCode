"""Run the recreate picker JS test from the pytest suite.

The client has no test runner of its own, so a ``.node.mjs`` file that
nothing invokes is a test that never runs. This wrapper puts
``tests/test_recreate_picker.node.mjs`` inside the one command the project
actually uses (``venv/bin/python3 -m pytest -q``), the same way
``test_restart_live_gate_runs.py`` carries its own JS sibling.

What it is carrying: the client half of punchlist item 22's missing side.
A session whose tmux SESSION is gone answers ``cannot_determine`` on the
restart preview, because the respawn ladder reads a PANE and there is none
to read. The picker notices that shape and asks the recreate endpoint
instead, carries the MODE that answered back to the caller so the action
posts to the endpoint that made the prediction, and falls back to the
honest refusal rather than to a blank panel when the second ask fails.

The load-bearing assertion is the negative one: a session measured ALIVE
is never re-asked. The recreate action CREATES a tmux session, and running
it beside a live one would leave the pane the user is talking to alive and
unreferenced.

Skipped, not failed, where node is absent: "could not evaluate" is its own
outcome and must not be spelled the same way as "the client is broken".
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

_JS_TEST = Path(__file__).resolve().parent / "test_recreate_picker.node.mjs"


@pytest.mark.skipif(
    subprocess.run(
        ["node", "--version"], capture_output=True, check=False
    ).returncode
    != 0,
    reason="node is not available in this environment",
)
def test_the_picker_asks_the_recreate_endpoint_only_when_it_should() -> None:
    """Run the JS sibling and require it to exit clean.

    Description: asserts on the child's exit status and attaches its whole
      output to the failure, so a break here reads as the JS assertion
      that failed rather than "subprocess returned 1".
    Inputs: none.
    Output: None.
    """
    result = subprocess.run(
        ["node", str(_JS_TEST)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        "the client-side recreate routing has broken:\n"
        f"{result.stdout}\n{result.stderr}"
    )
