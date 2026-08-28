"""Policy tests for pushing a CloudeCode rename into Claude Code.

Every function under test is pure, so the whole policy is exercised with
no tmux, no terminal and no Claude process. What that buys: the decision
that types text into a user's live pane is decided by code that can be
tested exhaustively, rather than by a condition discovered at runtime.
"""

import pytest

from src.core.claude_rename import (
    MAX_NAME_CHARS,
    MIN_RENAME_VERSION,
    PUSH_DEFERRED,
    PUSH_SENT,
    PUSH_UNSUPPORTED,
    decide_push,
    launch_name_args,
    name_is_pushable,
    parse_claude_version,
    rename_command,
    supports_rename,
)
from src.core.session_status import (
    STATUS_DEAD,
    STATUS_FINISHED_UNREAD,
    STATUS_IDLE,
    STATUS_QUESTION,
    STATUS_UNKNOWN,
    STATUS_WORKING,
    STATUS_WORKING_SUBAGENT,
)

VER = (2, 1, 248)


# ---- version parsing -------------------------------------------------

@pytest.mark.parametrize(
    "text,expected",
    [
        ("2.1.248 (Claude Code)", (2, 1, 248)),
        ("2.1.248", (2, 1, 248)),
        ("  2.1.205 (Claude Code)\n", (2, 1, 205)),
        ("not a version", None),
        ("2.1", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_claude_version(text, expected):
    assert parse_claude_version(text) == expected


def test_unknown_version_is_treated_as_unsupported():
    """The safe direction, and it must be asserted rather than assumed.

    Not sending costs a cosmetic mismatch. Sending `/rename Foo` to a
    build with no such command types a literal line into the user's
    conversation, which they then have to notice and delete.
    """
    assert supports_rename(None) is False
    assert supports_rename((2, 1, MIN_RENAME_VERSION[2] - 1)) is False
    assert supports_rename(MIN_RENAME_VERSION) is True


# ---- what may be sent at all -----------------------------------------

def test_a_newline_is_never_pushable():
    """send-keys would SUBMIT at the newline, splitting the label in two.

    Half would arrive as a /rename and the remainder as a prompt to
    Claude - a defect that writes into the user's conversation.
    """
    assert name_is_pushable("first\nsecond") is False
    assert name_is_pushable("carriage\rreturn") is False


def test_names_claude_would_rewrite_are_refused():
    assert name_is_pushable("x" * MAX_NAME_CHARS) is True
    assert name_is_pushable("x" * (MAX_NAME_CHARS + 1)) is False
    assert name_is_pushable("") is False
    assert name_is_pushable("   ") is False
    assert name_is_pushable("bell\x07here") is False


def test_ordinary_names_including_spaces_and_emoji_are_pushable():
    assert name_is_pushable("Refactor spike (round 2)") is True
    assert name_is_pushable("Refactor spike 🚀") is True


# ---- the send decision -----------------------------------------------

def _d(**kw):
    """decide_push with the safe defaults filled in."""
    base = dict(
        label="X",
        activity_status=STATUS_IDLE,
        hooks_seen=True,
        claude_version=VER,
        is_claude_session=True,
    )
    base.update(kw)
    return decide_push(**base)


def test_a_pane_at_a_prompt_gets_the_push():
    for state in (STATUS_IDLE, STATUS_FINISHED_UNREAD):
        outcome, _ = _d(activity_status=state)
        assert outcome == PUSH_SENT, state


def test_a_question_never_gets_typed_into():
    """The most dangerous state, and the reason this gate exists at all.

    When Claude has asked something and is waiting, text typed into the
    pane BECOMES the answer. A rename push landing there does not fail -
    it silently answers the question with "/rename Foo" and the
    conversation continues from that.
    """
    outcome, reason = _d(activity_status=STATUS_QUESTION)
    assert outcome == PUSH_DEFERRED
    assert "answer" in reason


@pytest.mark.parametrize(
    "state",
    [STATUS_WORKING, STATUS_WORKING_SUBAGENT, STATUS_DEAD, STATUS_UNKNOWN, None],
)
def test_every_other_state_defers_and_says_why(state):
    """The discriminating half.

    A test that only pinned the idle case would pass just as happily
    against code that sent unconditionally - which is the actual defect
    this replaces, since that code types into a pane mid-turn.
    """
    outcome, reason = _d(activity_status=state)
    assert outcome == PUSH_DEFERRED
    assert reason, "a deferral with no reason is not actionable"


def test_no_hook_signal_defers_even_when_the_status_says_idle():
    """THE BUG THIS GATE WAS REWRITTEN TO FIX.

    Every session launches through a wrapper (`zsh -c 'cld "$@"'`), so
    Claude runs as a CHILD of that shell and tmux's
    `pane_current_command` reports "zsh" forever - measured across all 7
    live sessions, thinking or idle alike. So the tmux fallback resolves
    to `idle` unconditionally.

    A gate that trusted that could never refuse. That is not a weak gate,
    it is an absent one - hazard 39's "verification step that cannot
    fail", in gate form. Without hook signal the answer must be "I cannot
    tell", never "idle".
    """
    outcome, reason = _d(activity_status=STATUS_IDLE, hooks_seen=False)
    assert outcome == PUSH_DEFERRED
    assert "no hook signal" in reason


def test_unknown_activity_is_not_an_idle_one():
    _, reason = _d(activity_status=STATUS_UNKNOWN)
    assert "could not be read" in reason


def test_non_claude_and_old_claude_are_unsupported_not_deferred():
    """Unsupported and deferred must not be the same answer.

    Deferred means try again later. Unsupported means never - retrying
    forever against a codex session would be a busy loop that can only
    ever fail.
    """
    outcome, _ = _d(is_claude_session=False)
    assert outcome == PUSH_UNSUPPORTED

    outcome, reason = _d(claude_version=(2, 1, 100))
    assert outcome == PUSH_UNSUPPORTED
    assert "2.1.205" in reason, "the reason must name the version needed"


def test_a_dead_pane_defers_before_the_hook_question_is_asked():
    """Order matters: dead is knowable without any hook signal."""
    outcome, reason = _d(activity_status=STATUS_DEAD, hooks_seen=False)
    assert outcome == PUSH_DEFERRED
    assert "dead" in reason


def test_an_unpushable_name_defers_rather_than_sending_a_different_one():
    outcome, reason = _d(label="bad\nname")
    assert outcome == PUSH_DEFERRED
    assert "disagree" in reason


def test_rename_command_is_the_literal_line():
    assert rename_command("My Session") == "/rename My Session"


# ---- the launch flag -------------------------------------------------

def test_launch_name_args_only_for_the_claude_family():
    """A per-FAMILY capability read off the family, not the wrapper.

    This is the cldl defect's exact shape: passing --name to codex or
    shell hands an unknown flag to a program that never had it, which
    breaks the launch rather than degrading it.
    """
    assert launch_name_args(label="S", family="claude", claude_version=VER) == ["--name", "S"]
    for family in ("codex", "hermes", "openclaw", "shell", "local", None):
        assert launch_name_args(label="S", family=family, claude_version=VER) == []


def test_launch_name_args_degrade_to_empty_never_raise():
    """Empty leaves the command line exactly as it was.

    The only safe failure mode for something that edits a command line is
    to change nothing.
    """
    assert launch_name_args(label=None, family="claude", claude_version=VER) == []
    assert launch_name_args(label="S", family="claude", claude_version=None) == []
    assert launch_name_args(label="S", family="claude", claude_version=(2, 1, 1)) == []
    assert launch_name_args(label="bad\nname", family="claude", claude_version=VER) == []


# ---- the launch-time wiring -----------------------------------------

def test_launch_name_args_for_resolves_the_family_that_will_run():
    """The wiring, not just the policy.

    `_launch_name_args_for` is where the family question is actually
    asked at launch. Pinning only `launch_name_args` would leave the
    call site free to pass the wrong family and still pass every test.
    """
    from src.core.claude_rename import launch_name_args_for_agent_type as _launch_name_args_for

    assert _launch_name_args_for(label=None, agent_type="claude") == []

    got = _launch_name_args_for(label="Spike", agent_type="claude")
    assert got in ([], ["--name", "Spike"]), (
        "either the local claude supports --name and we pass it, or it "
        "does not and we pass nothing - never anything else"
    )

    # The discriminating half: a non-claude family must NEVER get the flag,
    # regardless of what the local claude version happens to be.
    for family in ("codex", "hermes", "openclaw", "shell"):
        assert _launch_name_args_for(label="Spike", agent_type=family) == []


def test_an_unknown_agent_type_still_gets_the_flag_and_that_is_correct():
    """Follows `get_family`'s launch-time contract, not intuition.

    `get_family` never answers "I don't know" - a launch has to run
    something, so an unresolvable name falls back to the claude family.
    The command that then gets built IS a claude command, so `--name` is
    valid for it. Asserting `[]` here (the intuitive guess, and what this
    test originally claimed) would pin behaviour that contradicts the
    resolver the launch actually uses.

    What must hold is the pairing: whatever family the launch resolves
    to is the family whose flag support decides this.
    """
    from src.core.agent_families import get_family
    from src.core.claude_rename import launch_name_args_for_agent_type as _l

    for junk in ("no-such-agent-type", None):
        assert get_family(junk).name == "claude"
        assert _l(label="S", agent_type=junk) in ([], ["--name", "S"])

    # A REAL non-claude family is the case that must always be empty.
    assert get_family("shell").name == "shell"
    assert _l(label="S", agent_type="shell") == []
