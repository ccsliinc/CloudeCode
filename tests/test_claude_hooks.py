"""CloudeCode takes its hook block back out of ~/.claude/settings.json.

THIS SUITE USED TO PROVE THE OPPOSITE. It asserted that an idempotent
merge INSTALLED a managed hook block, that re-running it did not
duplicate one, and that an opt-out flag skipped the install. All of that
is deleted: the endpoint those hooks POSTed to is gone, because
``CLOUDECODE_SESSION_ID`` is a pane-wide environment variable and every
background agent reported under the parent's id, so the signal was wrong
nine times in ten. What answers the same question now is
``src/core/attention/``, which reads what the harness already writes to
disk.

The file left behind on every install that ever ran an older build is the
problem this suite now guards. It holds our block, aimed at nothing,
making Claude Code pay for a curl on every lifecycle event forever.
``strip_managed_hooks`` removes it once at boot.

WHAT THE CASES BELOW ARE REALLY PROTECTING, because "the block is gone"
is the easy half and a rm -f would satisfy it:

  * **A user's own hooks.** Every case that removes something has a
    user-authored entry sitting beside it, asserted byte-for-byte
    afterwards. A strip that took the whole ``hooks`` object would pass
    every removal assertion in this file and silently delete work the
    user did by hand.
  * **A file it cannot parse.** Unreadable JSON is left EXACTLY as it
    was. Rewriting a file we did not understand is the one failure here
    that cannot be undone.
  * **Not writing at all when there is nothing of ours.** Asserted by
    mtime and by content, because a strip that rewrote every settings
    file on every boot would churn a file we do not own.
  * **That the installer is really gone.** The last section asserts the
    module exports no block builder and no managed-event list, so the
    subsystem cannot come back by a merge that compiles.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_ch_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_ch_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core import claude_hooks
from src.core.claude_hooks import (
    CLOUDECODE_HOOKS_MARKER,
    _is_managed_command,
    strip_managed_hooks,
)


# --------------------------------------------------------------------- #
# Fixtures and shapes                                                    #
# --------------------------------------------------------------------- #


def _managed_entry(event: str = "Stop") -> dict:
    """One matcher entry shaped exactly as the old installer wrote it.

    Inputs: event (str) - only used to vary the command text.
    Output: dict - a ``{"matcher", "hooks"}`` entry carrying the marker.
    """
    return {
        "matcher": "*",
        "hooks": [
            {
                "type": "command",
                "command": (
                    f'(cat | curl -sS -m 2 -X POST "$CLOUDECODE_HOOK_URL" '
                    f'-H "X-Cloudecode-Event: {event}" --data-binary @-) '
                    f"> /dev/null 2>&1 ; : {CLOUDECODE_HOOKS_MARKER}"
                ),
            }
        ],
    }


def _user_entry(command: str = "echo mine") -> dict:
    """One matcher entry a human wrote, carrying no marker.

    Inputs: command (str).
    Output: dict.
    """
    return {
        "matcher": "Bash",
        "hooks": [{"type": "command", "command": command}],
    }


@pytest.fixture()
def settings_file(tmp_path, monkeypatch):
    """A settings.json path inside tmp, safe for the write guard.

    Inputs: tmp_path, monkeypatch (pytest fixtures).
    Output: Path - the file, which does not exist yet.
    """
    path = tmp_path / ".claude" / "settings.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv(claude_hooks.SETTINGS_PATH_ENV_VAR, str(path))
    return path


def _write(path: Path, payload: dict) -> None:
    """Write one settings document.

    Inputs: path (Path); payload (dict).
    Output: None.
    """
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _read(path: Path) -> dict:
    """Read one settings document back.

    Inputs: path (Path).
    Output: dict.
    """
    return json.loads(path.read_text(encoding="utf-8"))


# --------------------------------------------------------------------- #
# 1. NOTHING IS EVER INSTALLED                                           #
# --------------------------------------------------------------------- #


def test_a_missing_settings_file_is_left_missing(settings_file):
    """The strip never creates the file it was pointed at.

    The installer used to write one from scratch. A user who has never
    configured Claude Code must be left with no settings file at all,
    because creating one is itself a change to their machine.
    """
    assert strip_managed_hooks(settings_file) is True
    assert not settings_file.exists()


def test_a_file_with_no_hooks_key_is_untouched(settings_file):
    """Nothing of ours to remove, so nothing is written.

    Asserted by mtime as well as by content: a strip that rewrote every
    settings file on every boot would churn a file we do not own.
    """
    _write(settings_file, {"model": "opus", "theme": "dark"})
    before = settings_file.read_text(encoding="utf-8")
    mtime = settings_file.stat().st_mtime_ns

    assert strip_managed_hooks(settings_file) is True

    assert settings_file.read_text(encoding="utf-8") == before
    assert settings_file.stat().st_mtime_ns == mtime


def test_a_file_holding_only_user_hooks_is_untouched(settings_file):
    """THE NEGATIVE CONTROL for every removal case below.

    A strip that dropped the ``hooks`` object wholesale would pass every
    "our block is gone" assertion in this file and delete the user's work.
    """
    doc = {"hooks": {"PreToolUse": [_user_entry()], "Stop": [_user_entry("ls")]}}
    _write(settings_file, doc)
    mtime = settings_file.stat().st_mtime_ns

    assert strip_managed_hooks(settings_file) is True

    assert _read(settings_file) == doc
    assert settings_file.stat().st_mtime_ns == mtime


def test_the_strip_is_idempotent(settings_file):
    """Running it twice reaches the same file, and writes once.

    The second pass finds nothing of ours and must take the no-write
    path, which is what keeps a boot loop from rewriting the file.
    """
    _write(settings_file, {"hooks": {"Stop": [_managed_entry()]}})
    assert strip_managed_hooks(settings_file) is True
    after_first = settings_file.read_text(encoding="utf-8")
    mtime = settings_file.stat().st_mtime_ns

    assert strip_managed_hooks(settings_file) is True

    assert settings_file.read_text(encoding="utf-8") == after_first
    assert settings_file.stat().st_mtime_ns == mtime


# --------------------------------------------------------------------- #
# 2. AN EXISTING MANAGED BLOCK IS FULLY REMOVED                          #
# --------------------------------------------------------------------- #


def test_a_whole_managed_block_is_removed_down_to_the_hooks_key(settings_file):
    """The upgrade case: every event key goes, and so does ``hooks``.

    A user who never wrote a hook of their own is left with exactly the
    file they would have had if CloudeCode had never run. Stopping at
    "the lists are empty" leaves litter that reads like configuration.
    """
    events = [
        "Stop",
        "Notification",
        "PermissionRequest",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "SubagentStart",
        "SubagentStop",
        "SessionStart",
        "SessionEnd",
    ]
    _write(
        settings_file,
        {
            "model": "opus",
            "hooks": {event: [_managed_entry(event)] for event in events},
        },
    )

    assert strip_managed_hooks(settings_file) is True

    doc = _read(settings_file)
    assert "hooks" not in doc
    assert doc == {"model": "opus"}
    assert CLOUDECODE_HOOKS_MARKER not in settings_file.read_text(encoding="utf-8")


def test_a_user_hook_survives_beside_a_removed_managed_one(settings_file):
    """THE LOAD-BEARING CASE. Both entries sit under the same event key.

    This is the shape the old merge produced on a machine where the user
    already had a ``Stop`` hook: the user's entry first, ours appended
    after it. Only ours may go, and the user's must come back byte for
    byte, still a list, still under its own key.
    """
    mine = _user_entry("say-done")
    _write(
        settings_file,
        {
            "hooks": {
                "Stop": [mine, _managed_entry("Stop")],
                "PreToolUse": [_managed_entry("PreToolUse")],
            }
        },
    )

    assert strip_managed_hooks(settings_file) is True

    doc = _read(settings_file)
    assert doc == {"hooks": {"Stop": [mine]}}


def test_an_event_key_the_user_owns_outright_keeps_its_empty_list(settings_file):
    """An empty list WE did not empty is the user's, and stays.

    The rule is "drop a key this strip emptied", not "drop every empty
    key". Deleting one we never touched would be this function editing
    something it did not write.
    """
    _write(
        settings_file,
        {"hooks": {"Notification": [], "Stop": [_managed_entry()]}},
    )

    assert strip_managed_hooks(settings_file) is True

    assert _read(settings_file) == {"hooks": {"Notification": []}}


def test_a_matcher_shape_we_never_wrote_is_preserved_verbatim(settings_file):
    """Anything unrecognisable passes through untouched.

    A settings file is a user's document. A value we cannot classify is
    not ours to normalise, reorder or drop.
    """
    _write(
        settings_file,
        {
            "hooks": {
                "Weird": {"not": "a list"},
                "AlsoWeird": ["a bare string", 7],
                "Stop": [_managed_entry()],
            }
        },
    )

    assert strip_managed_hooks(settings_file) is True

    assert _read(settings_file) == {
        "hooks": {"Weird": {"not": "a list"}, "AlsoWeird": ["a bare string", 7]}
    }


def test_a_mixed_matcher_entry_is_dropped_whole(settings_file):
    """One marked command in an entry condemns that entry, and only it.

    Every hook the installer ever wrote lived alone in its own matcher,
    so this cannot take a user's hook down with it - and the sibling
    entry in this case proves the blast radius stops at the entry.
    """
    mixed = {
        "matcher": "*",
        "hooks": [
            {"type": "command", "command": "echo first"},
            _managed_entry()["hooks"][0],
        ],
    }
    mine = _user_entry("echo untouched")
    _write(settings_file, {"hooks": {"Stop": [mixed, mine]}})

    assert strip_managed_hooks(settings_file) is True

    assert _read(settings_file) == {"hooks": {"Stop": [mine]}}


# --------------------------------------------------------------------- #
# 3. A FILE IT CANNOT READ IS NEVER REWRITTEN                            #
# --------------------------------------------------------------------- #


def test_unparseable_json_bails_without_clobbering(settings_file):
    """LOG AND BAIL. The one failure here that cannot be undone.

    Returns False so the caller logs it, and leaves the bytes alone.
    """
    settings_file.write_text('{"hooks": {"Stop": [', encoding="utf-8")
    before = settings_file.read_text(encoding="utf-8")

    assert strip_managed_hooks(settings_file) is False

    assert settings_file.read_text(encoding="utf-8") == before


def test_a_top_level_non_object_bails_without_clobbering(settings_file):
    """A settings file that is a list is not one we can merge into."""
    settings_file.write_text("[1, 2, 3]", encoding="utf-8")

    assert strip_managed_hooks(settings_file) is False

    assert settings_file.read_text(encoding="utf-8") == "[1, 2, 3]"


def test_an_empty_file_is_a_no_op_success(settings_file):
    """Nothing in it, nothing of ours, nothing written."""
    settings_file.write_text("   \n", encoding="utf-8")

    assert strip_managed_hooks(settings_file) is True

    assert settings_file.read_text(encoding="utf-8") == "   \n"


def test_a_hooks_value_of_the_wrong_type_is_left_alone(settings_file):
    """``hooks`` as a string is not a block we wrote, so we do not touch it."""
    _write(settings_file, {"hooks": "surprise"})

    assert strip_managed_hooks(settings_file) is True

    assert _read(settings_file) == {"hooks": "surprise"}


# --------------------------------------------------------------------- #
# 4. THE DESTINATION IS EXPLICIT, AND THE GUARD IS REAL                  #
# --------------------------------------------------------------------- #


def test_default_settings_path_honours_the_override(settings_file, monkeypatch):
    """The env override is what keeps a plain pytest run off ~/.claude."""
    assert claude_hooks.default_settings_path() == settings_file


def test_default_settings_path_falls_back_to_the_home_file(monkeypatch):
    """With no override it names the real Claude Code settings file."""
    monkeypatch.delenv(claude_hooks.SETTINGS_PATH_ENV_VAR, raising=False)
    assert claude_hooks.default_settings_path() == (
        Path.home() / ".claude" / "settings.json"
    )


def test_the_write_guard_refuses_a_destination_outside_tmp(tmp_path):
    """A harness violation FAILS LOUDLY rather than returning False.

    Deliberately not folded into the handled-failure path: a test that
    aimed this at a real home directory must stop the run, not log.
    """
    from src.core.test_write_guard import OutsideTempWriteError

    with pytest.raises(OutsideTempWriteError):
        strip_managed_hooks(Path("/definitely/not/tmp/settings.json"))


# --------------------------------------------------------------------- #
# 5. THE MARKER, WHICH IS THE WHOLE BASIS OF "OURS"                      #
# --------------------------------------------------------------------- #


def test_the_marker_identifies_only_our_own_commands():
    """The classifier the strip is built on, on its own."""
    assert _is_managed_command(f"curl ... ; : {CLOUDECODE_HOOKS_MARKER}") is True
    assert _is_managed_command("echo mine") is False


@pytest.mark.parametrize("value", [None, 7, {"nested": True}, ["list"]])
def test_a_non_string_command_is_not_ours_and_does_not_raise(value):
    """A user's hook with an unexpected shape cannot crash the strip."""
    assert _is_managed_command(value) is False


# --------------------------------------------------------------------- #
# 6. THE INSTALLER CANNOT COME BACK                                      #
# --------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "name",
    [
        "ensure_hook_settings",
        "_build_hook_block",
        "_build_managed_command",
        "_merge_hooks",
        "_MANAGED_EVENTS",
        "_hooks_disabled",
    ],
)
def test_the_module_exports_no_installer(name):
    """THE RATCHET. A merge that re-adds any of these fails here.

    Each name is one half of the old install path. The subsystem coming
    back would be a change somebody makes on purpose, not a name that
    reappears in a merge from a branch that never heard about this.
    """
    assert not hasattr(claude_hooks, name), (
        f"claude_hooks.{name} is back; the hook installer was deleted on "
        f"2026-09-13 and nothing may reinstate it without a decision"
    )


def test_the_opt_out_setting_is_gone_from_the_config_model():
    """``disable_claude_hooks`` must not gate the cleanup.

    Honouring an opt-out here would skip the strip for exactly the users
    who asked not to have the block - the ones most likely to still be
    carrying one installed before they set the flag.
    """
    from src.config.notifications import NotificationsConfig

    assert "disable_claude_hooks" not in NotificationsConfig.model_fields
