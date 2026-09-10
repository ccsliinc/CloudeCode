"""Punchlist 3: infer a hand-started session's agent from its process.

THE NEGATIVE CONTROLS ARE THE LOAD-BEARING TESTS HERE. A matcher that
always finds something would pass every positive case in this file
perfectly and still be worse than useless - it would replace "unknown
family", which is honest, with a confident wrong wrapper name. So the
refusals are asserted first and in more detail than the matches: a plain
shell writes nothing, an ambiguous argv names no wrapper, an unreadable
process table is not a finding, and a launched value is never touched.
"""

from __future__ import annotations

import sqlite3

import pytest

from src.core.claude_resume_argv import ProcessRow, find_claude_commands_in_tree
from src.core.db_models import (
    SESSION_FAMILY_SOURCE_INFERRED_PROCESS,
    SESSION_FAMILY_SOURCE_LAUNCHED,
    SESSION_FAMILY_SOURCE_NOT_LAUNCHED,
)
from src.core.session_agent_infer import (
    INFER_FAMILY,
    INFER_NOT_CLAUDE,
    INFER_OUTCOMES,
    INFER_UNAVAILABLE,
    INFER_WRAPPER,
    flag_signature,
    matching_wrapper_ids,
    resolve_agent_inference,
    restart_agent_type,
    wrapper_flag_signature,
)
from src.core.session_agent_infer_apply import (
    persist_inferred_agent_type,
    read_pane_process_evidence,
)


def wrapper(wid, script, family="claude"):
    """An AgentWrapper-shaped dict, the dual type every resolver accepts.

    Inputs: wid (str), script (str), family (str).
    Output: dict.
    """
    return {"id": wid, "script": script, "family": family, "label": wid}


CHROME = wrapper("claude-chrome", 'command claude --chrome "$@"')
SKIP = wrapper(
    "claude-skip-permissions",
    'command claude --dangerously-skip-permissions "$@"',
)
BOTH = wrapper(
    "claude-chrome-skip",
    'command claude --chrome --dangerously-skip-permissions "$@"',
)
THIN = wrapper("cld", 'cld "$@"')
THIN2 = wrapper("cld2", 'cld2 "$@"')


# --------------------------------------------------------------------
# signatures
# --------------------------------------------------------------------


def test_per_run_flags_are_removed_from_both_sides():
    """--resume/--name/--model belong to the run, not to the wrapper."""
    assert flag_signature(
        "claude --chrome --resume 82854c0e-a423-4591-a34f-a14cb92fbf41 "
        "--name 'a session'"
    ) == frozenset({"--chrome"})
    assert flag_signature("claude --model=x --continue") == frozenset()


def test_a_wrapper_signature_ignores_flags_that_are_not_claudes():
    """A wrapper's own setup lines must not pollute its signature."""
    real = wrapper(
        "cld-real",
        "cld() (\n"
        "  security find-generic-password --account foo --wacky-flag\n"
        "  export ANTHROPIC_BASE_URL=https://example.invalid\n"
        '  command claude --dangerously-skip-permissions "$@"\n'
        ")",
    )
    assert wrapper_flag_signature(real) == frozenset(
        {"--dangerously-skip-permissions"}
    )


def test_a_thin_wrapper_has_no_signature_at_all():
    """It calls a function from the user's zshrc; we cannot see inside."""
    assert wrapper_flag_signature(THIN) == frozenset()


# --------------------------------------------------------------------
# NEGATIVE CONTROL: the matcher must be able to find nothing
# --------------------------------------------------------------------


def test_an_empty_observation_matches_no_wrapper_even_when_one_is_flagless():
    """THE ANCHOR GATE. Empty agreeing with empty is not evidence."""
    assert matching_wrapper_ids(frozenset(), [THIN, CHROME]) == ()


def test_equality_not_subset_so_one_wrapper_cannot_claim_anothers_pane():
    """--chrome must not match the wrapper that passes --chrome AND skip."""
    assert matching_wrapper_ids(frozenset({"--chrome"}), [BOTH]) == ()


def test_a_non_claude_family_wrapper_is_never_a_candidate():
    """A codex wrapper cannot have started the claude binary."""
    codex = wrapper("codex-chrome", "codex --chrome", family="codex")
    assert matching_wrapper_ids(frozenset({"--chrome"}), [codex]) == ()


def test_a_plain_shell_pane_writes_nothing():
    """THE HEADLINE NEGATIVE CONTROL. zsh, no claude, no hook: refuse."""
    verdict = resolve_agent_inference(
        claude_argv=None,
        pane_current_command="zsh",
        process_table_read=True,
        wrappers=[CHROME, SKIP],
    )
    assert verdict.outcome == INFER_NOT_CLAUDE
    assert verdict.agent_type is None
    assert verdict.family_source is None


def test_an_unreadable_process_table_is_not_a_finding():
    """Not having looked is never evidence of absence."""
    verdict = resolve_agent_inference(
        claude_argv=None,
        pane_current_command="zsh",
        process_table_read=False,
        wrappers=[CHROME],
    )
    assert verdict.outcome == INFER_UNAVAILABLE
    assert verdict.agent_type is None


def test_a_version_string_pane_command_creates_nothing():
    """The measured common case: tmux reports a claude VERSION here.

    It corroborates and must never create - matching it would be a rung
    that fires on noise.
    """
    verdict = resolve_agent_inference(
        claude_argv=None,
        pane_current_command="2.1.263",
        process_table_read=True,
        wrappers=[CHROME],
    )
    assert verdict.outcome == INFER_NOT_CLAUDE


def test_two_matching_wrappers_write_the_bare_family_not_a_coin_flip():
    """REQUIRED CASE: an argv matching two wrappers names neither."""
    twin = wrapper("claude-chrome-twin", 'command claude --chrome "$@"')
    verdict = resolve_agent_inference(
        claude_argv="/usr/bin/claude --chrome",
        pane_current_command="claude",
        process_table_read=True,
        wrappers=[CHROME, twin],
    )
    assert verdict.outcome == INFER_FAMILY
    assert verdict.agent_type == "claude"
    assert set(verdict.candidates) == {"claude-chrome", "claude-chrome-twin"}


def test_a_bare_claude_argv_writes_the_family_not_the_only_wrapper():
    """No distinguishing flag means no wrapper, even with one configured."""
    verdict = resolve_agent_inference(
        claude_argv="claude",
        pane_current_command="claude",
        process_table_read=True,
        wrappers=[THIN, THIN2],
    )
    assert verdict.outcome == INFER_FAMILY
    assert verdict.agent_type == "claude"


# --------------------------------------------------------------------
# positive
# --------------------------------------------------------------------


def test_a_single_matching_wrapper_is_named():
    verdict = resolve_agent_inference(
        claude_argv="/Users/x/.local/bin/claude --chrome --resume "
        "82854c0e-a423-4591-a34f-a14cb92fbf41",
        pane_current_command="claude",
        process_table_read=True,
        wrappers=[CHROME, SKIP, BOTH, THIN],
    )
    assert verdict.outcome == INFER_WRAPPER
    assert verdict.agent_type == "claude-chrome"
    assert verdict.family_source == SESSION_FAMILY_SOURCE_INFERRED_PROCESS


def test_a_pane_whose_own_command_is_claude_proves_the_family():
    """Corroboration is allowed to answer when the argv is unreadable."""
    verdict = resolve_agent_inference(
        claude_argv=None,
        pane_current_command="/opt/homebrew/bin/claude",
        process_table_read=True,
        wrappers=[CHROME],
    )
    assert verdict.outcome == INFER_FAMILY
    assert verdict.agent_type == "claude"


def test_every_outcome_is_in_the_declared_vocabulary():
    for argv, read in (
        (None, False),
        (None, True),
        ("claude --chrome", True),
        ("claude", True),
    ):
        verdict = resolve_agent_inference(
            claude_argv=argv,
            pane_current_command="zsh",
            process_table_read=read,
            wrappers=[CHROME],
        )
        assert verdict.outcome in INFER_OUTCOMES


# --------------------------------------------------------------------
# the fakeable read
# --------------------------------------------------------------------


TABLE = [
    ProcessRow(pid=100, ppid=1, command="/bin/zsh -l"),
    ProcessRow(pid=200, ppid=100, command="/Users/x/.local/bin/claude --chrome"),
    ProcessRow(pid=300, ppid=1, command="/bin/zsh"),
]


def test_the_read_finds_a_claude_child_of_the_panes_shell():
    read, argv = read_pane_process_evidence(100, table_reader=lambda: TABLE)
    assert read is True
    assert argv == "/Users/x/.local/bin/claude --chrome"


def test_the_read_reports_a_shell_only_pane_as_read_with_nothing_found():
    read, argv = read_pane_process_evidence(300, table_reader=lambda: TABLE)
    assert read is True
    assert argv is None


def test_an_unreadable_table_and_a_missing_pid_both_report_not_read():
    assert read_pane_process_evidence(100, table_reader=lambda: None) == (False, None)
    assert read_pane_process_evidence(None, table_reader=lambda: TABLE) == (False, None)


def test_the_walk_finds_the_pane_pid_itself_when_tmux_ran_claude_directly():
    table = [ProcessRow(pid=500, ppid=1, command="claude --chrome")]
    assert find_claude_commands_in_tree(500, table) == ["claude --chrome"]


# --------------------------------------------------------------------
# the write
# --------------------------------------------------------------------


@pytest.fixture()
def conn():
    """A sessions table with the three rows the write rules turn on.

    Output: sqlite3.Connection with rows ``bare`` (not_launched, the
      punchlist 3 shape), ``launched`` (a recorded launch) and
      ``already`` (an earlier inference).
    """
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute(
        "CREATE TABLE sessions (session_uuid TEXT PRIMARY KEY, "
        "agent_type TEXT, agent_family TEXT, agent_family_source TEXT)"
    )
    c.executemany(
        "INSERT INTO sessions VALUES (?, ?, ?, ?)",
        [
            ("bare", None, None, SESSION_FAMILY_SOURCE_NOT_LAUNCHED),
            ("launched", "claude-chrome", "claude", SESSION_FAMILY_SOURCE_LAUNCHED),
            (
                "already",
                "claude",
                "claude",
                SESSION_FAMILY_SOURCE_INFERRED_PROCESS,
            ),
        ],
    )
    c.commit()
    return c


def write(c, uuid, agent_type):
    """Run the real write once. Output: bool - did a row move."""
    return persist_inferred_agent_type(
        c,
        session_uuid=uuid,
        agent_type=agent_type,
        family_source=SESSION_FAMILY_SOURCE_INFERRED_PROCESS,
        agent_family="claude",
    )


def test_a_not_launched_row_is_filled_and_the_pair_moves_together(conn):
    assert write(conn, "bare", "claude-chrome") is True
    row = conn.execute(
        "SELECT * FROM sessions WHERE session_uuid = 'bare'"
    ).fetchone()
    assert row["agent_type"] == "claude-chrome"
    assert row["agent_family"] == "claude"
    assert row["agent_family_source"] == SESSION_FAMILY_SOURCE_INFERRED_PROCESS


def test_a_second_identical_pass_writes_nothing(conn):
    assert write(conn, "bare", "claude-chrome") is True
    assert write(conn, "bare", "claude-chrome") is False


def test_a_second_pass_with_a_different_answer_still_writes_nothing(conn):
    """Idempotence is the WHERE clause, not a comparison of values."""
    assert write(conn, "bare", "claude-chrome") is True
    assert write(conn, "bare", "claude-skip-permissions") is False
    row = conn.execute(
        "SELECT agent_type FROM sessions WHERE session_uuid = 'bare'"
    ).fetchone()
    assert row["agent_type"] == "claude-chrome"


def test_a_launched_value_is_never_overwritten(conn):
    assert write(conn, "launched", "claude-skip-permissions") is False
    row = conn.execute(
        "SELECT agent_type, agent_family_source FROM sessions "
        "WHERE session_uuid = 'launched'"
    ).fetchone()
    assert row["agent_type"] == "claude-chrome"
    assert row["agent_family_source"] == SESSION_FAMILY_SOURCE_LAUNCHED


def test_a_row_that_does_not_exist_is_a_no_op_not_a_raise(conn):
    assert write(conn, "nope", "claude") is False


# --------------------------------------------------------------------
# an inference is not intent
# --------------------------------------------------------------------


def test_the_restart_ladder_never_reads_an_inferred_agent_type():
    assert restart_agent_type("claude-chrome", SESSION_FAMILY_SOURCE_INFERRED_PROCESS) is None


def test_the_restart_ladder_still_reads_a_launched_one():
    assert (
        restart_agent_type("claude-chrome", SESSION_FAMILY_SOURCE_LAUNCHED)
        == "claude-chrome"
    )
    assert restart_agent_type("claude-chrome", None) == "claude-chrome"
