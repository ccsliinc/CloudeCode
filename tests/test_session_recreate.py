"""The recreate gate and the recreate plan, with no tmux and no database.

WHAT IS ACTUALLY BEING PINNED HERE. Recreating a session CREATES a tmux
session and REBINDS a database row onto it, and both halves are
irreversible from the user's side. So the tests that matter most are the
ones that prove it REFUSES: over a live tmux session, over a listing that
did not answer, over a listing that answered incompletely, and over a
conversation measured missing. A gate that only ever passes is not a
gate, and every one of those branches is unreachable on a working box -
which is precisely why they are exercised here as pure functions rather
than left to be discovered in the field.

THE NEGATIVE CONTROLS ARE THE LOAD-BEARING TESTS. ``test_a_live_tmux
_session_is_never_recreated`` and the two unknown-listing tests would all
pass trivially against an implementation that offered a recreate for
everything, if the positive test were the only one present.
"""

import pytest

from src.core.session_imported_restart import (
    DIRECTORY_MEASURED,
    DIRECTORY_NOT_FOUND,
    DIRECTORY_UNCHECKED,
    ResumeDirectory,
)
from src.core.session_recreate import (
    RECREATE,
    has_tmux_identity,
    plan_recreate,
)
from src.core.session_recreate_presence import (
    ALL_TMUX_PRESENCE,
    TMUX_GONE,
    TMUX_PRESENT,
    TMUX_UNKNOWN,
    TmuxPresence,
    pane_state_for,
    tmux_presence,
)
from src.core.session_respawn import (
    PANE_ALIVE,
    PANE_DEAD,
    PANE_UNKNOWN,
    RESPAWN_CANNOT_DETERMINE,
    RESPAWN_NOT_DEAD,
    RESPAWN_TRANSCRIPT_MISSING,
)
from src.core.session_resume_target import (
    CONVERSATION_NONE_RECORDED,
    CONVERSATION_RESUMED,
)

NAME = "cloude_demo"
UUID = "11111111-2222-3333-4444-555555555555"
RESUME_CMD = f"zsh -c 'source ~/.zshrc; cld --resume {UUID}'"
PLAIN_CMD = "zsh -c 'source ~/.zshrc; cld'"


def _row(**over):
    """A sessions row with a tmux identity and a conversation.

    Inputs: **over - column overrides. Output: dict.
    """
    row = {
        "id": 7,
        "session_uuid": "ses-uuid-7",
        "tmux_socket": "cloude",
        "tmux_name": NAME,
        "tmux_created_epoch": 1788821572,
        "working_dir": "/tmp/project",
        "claude_session_uuid": UUID,
        "title": "demo",
        "agent_type": "claude-chrome",
        "model": None,
    }
    row.update(over)
    return row


def _measured(spelling="/tmp/project"):
    """A directory measurement that found the transcript.

    Inputs: spelling (str). Output: ResumeDirectory.
    """
    return ResumeDirectory(
        outcome=DIRECTORY_MEASURED,
        working_dir=spelling,
        transcript_path=f"{spelling}/{UUID}.jsonl",
        checked=(spelling,),
        detail="found",
    )


# ---------------------------------------------------------------- the gate


def test_a_complete_listing_without_the_name_is_a_measured_absence():
    """The one outcome a recreate may act on, and the only one."""
    verdict = tmux_presence(
        NAME, listing_ok=True, listing_complete=True, names=["cloude_other"]
    )
    assert verdict.outcome == TMUX_GONE
    assert verdict.gone is True
    assert NAME in verdict.detail


def test_a_name_in_the_listing_is_present():
    """NEGATIVE CONTROL. A running session must never read as gone."""
    verdict = tmux_presence(
        NAME, listing_ok=True, listing_complete=True, names=["cloude_other", NAME]
    )
    assert verdict.outcome == TMUX_PRESENT
    assert verdict.gone is False


def test_a_listing_that_did_not_run_is_unknown_and_never_gone():
    """NEGATIVE CONTROL, and the one ``is_alive()`` would get wrong.

    ``has-session`` returns the same False for "no such session" and for
    "tmux could not be reached", so a gate built on it would recreate a
    live session over a socket hiccup.
    """
    verdict = tmux_presence(
        NAME, listing_ok=False, listing_complete=False, names=[]
    )
    assert verdict.outcome == TMUX_UNKNOWN
    assert verdict.gone is False


def test_an_incomplete_listing_is_unknown_even_though_the_name_is_absent():
    """A refused row is a name nobody read, and it may be this one."""
    verdict = tmux_presence(
        NAME, listing_ok=True, listing_complete=False, names=["cloude_other"]
    )
    assert verdict.outcome == TMUX_UNKNOWN


def test_a_name_present_in_an_incomplete_listing_is_still_present():
    """Finding it is positive evidence whatever else the listing dropped."""
    verdict = tmux_presence(
        NAME, listing_ok=True, listing_complete=False, names=[NAME]
    )
    assert verdict.outcome == TMUX_PRESENT


def test_a_name_outside_the_namespace_is_unknown_not_gone():
    """Reading the FILTER is not reading the socket.

    ``discover_existing`` only returns ``cloude_``-prefixed names, so an
    adopted external session is absent from it whether or not it runs.
    """
    verdict = tmux_presence(
        "my_own_tmux", listing_ok=True, listing_complete=True, names=[NAME]
    )
    assert verdict.outcome == TMUX_UNKNOWN
    assert "namespace" in verdict.detail


def test_a_blank_name_is_unknown():
    """Nothing was asked, so nothing was measured."""
    assert tmux_presence(
        "", listing_ok=True, listing_complete=True, names=[]
    ).outcome == TMUX_UNKNOWN


@pytest.mark.parametrize(
    "outcome,expected",
    [
        (TMUX_GONE, PANE_DEAD),
        (TMUX_PRESENT, PANE_ALIVE),
        (TMUX_UNKNOWN, PANE_UNKNOWN),
    ],
)
def test_every_presence_maps_to_one_of_the_models_three_pane_words(
    outcome, expected
):
    """The preview teaches the client no fourth word."""
    assert pane_state_for(TmuxPresence(outcome=outcome)) == expected


def test_every_presence_constant_is_covered_by_the_mapping():
    """A NEW presence value must not silently render as unknown."""
    seen = {pane_state_for(TmuxPresence(outcome=o)) for o in ALL_TMUX_PRESENCE}
    assert seen == {PANE_DEAD, PANE_ALIVE, PANE_UNKNOWN}


# ---------------------------------------------------------------- the plan


def test_a_gone_session_with_a_wrapper_and_a_transcript_is_recreated():
    """The positive case: the rung, the command and the resume clause."""
    plan = plan_recreate(
        _row(),
        row_read_ok=True,
        presence=TmuxPresence(TMUX_GONE),
        choice_verdict="accepted",
        choice_command=RESUME_CMD,
        agent_type="claude-chrome",
        directory=_measured(),
    )
    assert plan.kind == RECREATE
    assert plan.actionable is True
    assert plan.command == RESUME_CMD
    assert plan.conversation == CONVERSATION_RESUMED
    assert plan.reuse_session_id == 7
    assert plan.tmux_name == NAME
    assert plan.working_dir == "/tmp/project"
    assert "scrollback does not" in plan.detail


def test_a_live_tmux_session_is_never_recreated():
    """THE GATE. Recreating over a live pane orphans the running agent.

    A second tmux session would be spawned and the row rebound onto the
    newcomer, leaving the pane the user is talking to alive and
    unreferenced. The refusal reuses the ladder's own ``not_dead``.
    """
    plan = plan_recreate(
        _row(),
        row_read_ok=True,
        presence=TmuxPresence(TMUX_PRESENT, detail="still on the socket"),
        choice_verdict="accepted",
        choice_command=RESUME_CMD,
        agent_type="claude-chrome",
        directory=_measured(),
    )
    assert plan.kind == RESPAWN_NOT_DEAD
    assert plan.actionable is False
    assert plan.command is None


def test_an_unknown_presence_refuses_even_with_everything_else_in_hand():
    """Not having looked is not evidence of absence."""
    plan = plan_recreate(
        _row(),
        row_read_ok=True,
        presence=TmuxPresence(TMUX_UNKNOWN, detail="could not list"),
        choice_verdict="accepted",
        choice_command=RESUME_CMD,
        agent_type="claude-chrome",
        directory=_measured(),
    )
    assert plan.kind == RESPAWN_CANNOT_DETERMINE
    assert plan.actionable is False


def test_a_measured_missing_transcript_refuses_ahead_of_the_wrapper():
    """No wrapper choice makes a deleted conversation resumable."""
    plan = plan_recreate(
        _row(),
        row_read_ok=True,
        presence=TmuxPresence(TMUX_GONE),
        choice_verdict="accepted",
        choice_command=RESUME_CMD,
        agent_type="claude-chrome",
        directory=ResumeDirectory(
            outcome=DIRECTORY_NOT_FOUND,
            checked=("/tmp/project",),
            detail="no transcript for this conversation is filed anywhere",
        ),
    )
    assert plan.kind == RESPAWN_TRANSCRIPT_MISSING
    assert plan.actionable is False


def test_an_unchecked_directory_never_refuses():
    """``unchecked`` is not a negative, and refusing on it would break
    recreate on every machine whose corpus lives somewhere we were not
    told about."""
    plan = plan_recreate(
        _row(),
        row_read_ok=True,
        presence=TmuxPresence(TMUX_GONE),
        choice_verdict="accepted",
        choice_command=RESUME_CMD,
        agent_type="claude-chrome",
        directory=ResumeDirectory(outcome=DIRECTORY_UNCHECKED, detail="not looked"),
    )
    assert plan.kind == RECREATE
    assert plan.actionable is True


def test_a_row_with_no_conversation_recreates_and_says_none_recorded():
    """The session still comes back; it never claims to have resumed.

    Silently starting a blank session under a familiar title is the false
    green this codebase is built against, so the sentence says the
    history is not coming with it.
    """
    plan = plan_recreate(
        _row(claude_session_uuid=None),
        row_read_ok=True,
        presence=TmuxPresence(TMUX_GONE),
        choice_verdict="accepted",
        choice_command=PLAIN_CMD,
        agent_type="claude-chrome",
        directory=ResumeDirectory(outcome=DIRECTORY_UNCHECKED),
    )
    assert plan.kind == RECREATE
    assert plan.conversation == CONVERSATION_NONE_RECORDED
    assert "WITHOUT its history" in plan.detail


def test_the_conversation_is_derived_from_the_argv_not_from_the_row():
    """A command carrying no --resume can never claim a resume, whatever
    the row holds."""
    plan = plan_recreate(
        _row(),
        row_read_ok=True,
        presence=TmuxPresence(TMUX_GONE),
        choice_verdict="accepted",
        choice_command=PLAIN_CMD,
        agent_type="claude-chrome",
        directory=_measured(),
    )
    assert plan.conversation != CONVERSATION_RESUMED


def test_an_unpicked_recreate_is_not_actionable():
    """There is no recorded start command left to fall back on, so an
    unpicked recreate would only ever be a login shell."""
    plan = plan_recreate(
        _row(),
        row_read_ok=True,
        presence=TmuxPresence(TMUX_GONE),
        choice_verdict=None,
        choice_command=None,
        choice_detail="nothing picked",
        directory=_measured(),
    )
    assert plan.kind == RESPAWN_CANNOT_DETERMINE
    assert plan.actionable is False


def test_an_unreadable_row_refuses_before_anything_else_is_considered():
    """Every later gate reads the row."""
    plan = plan_recreate(
        None,
        row_read_ok=False,
        presence=TmuxPresence(TMUX_GONE),
        choice_verdict="accepted",
        choice_command=RESUME_CMD,
    )
    assert plan.kind == RESPAWN_CANNOT_DETERMINE


def test_a_plan_never_carries_permission_to_kill_a_live_pane():
    """``kills_live_pane`` is False BY CONSTRUCTION on this path."""
    from src.core.session_recreate import as_respawn_plan

    plan = plan_recreate(
        _row(),
        row_read_ok=True,
        presence=TmuxPresence(TMUX_GONE),
        choice_verdict="accepted",
        choice_command=RESUME_CMD,
        agent_type="claude-chrome",
        directory=_measured(),
    )
    rendered = as_respawn_plan(plan)
    assert rendered.kills_live_pane is False
    assert rendered.kind == RECREATE


# ------------------------------------------------------- the row partition


def test_the_two_restart_paths_partition_every_row_between_them():
    """A row is imported XOR it has a tmux identity, and the test is
    written once."""
    from src.core.session_imported_restart import is_imported_row

    for row in (
        _row(),
        _row(tmux_name=None, tmux_created_epoch=None),
        _row(tmux_name=NAME, tmux_created_epoch=None),
    ):
        assert has_tmux_identity(row) is not is_imported_row(row)


def test_no_row_has_no_identity():
    """None is not a row with a tmux name."""
    assert has_tmux_identity(None) is False
