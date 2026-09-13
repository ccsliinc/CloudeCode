"""The registry reader must be able to say "I do not know", and prove it.

THE FIXTURES IN THIS FILE ARE REAL. Every payload below was copied out of
``~/.claude/sessions/*.json`` on this Mac on 2026-09-13, running Claude
Code 2.1.266: a session blocked on an AskUserQuestion menu, one idle at
the prompt, one running a shell command on an older 2.1.257, and one
belonging to somebody else's tmux server (``classic:@0.%0``). Keys,
spellings, epoch shapes and version strings are the writer's, not this
author's. A reader of an undocumented file that is only ever tested
against payloads its own author invented proves that the author can spell
their own field names.

WHAT THIS SUITE IS ACTUALLY FOR. The file is written by a binary nobody
promised us anything about, and the cost of a wrong answer is a toast on
somebody's phone claiming a session is finished when it is not. So the
tests that matter most are not the happy path: they are the ones that
prove each refusal can actually fire. Gotcha 11 in CLAUDE.md is the rule -
A GREEN CHECK MUST FIRST PROVE IT CAN GO RED - and the load-bearing test
here is
``test_a_record_with_every_field_missing_is_never_ok_and_never_idle``: an
empty object must refuse, because the one failure this whole feature
exists to remove is a confident "idle" about a session we know nothing
about.

Every refusal test is paired with a positive control that takes the same
path and comes back :data:`REG_OK`, so a reader that refused everything
would fail this file rather than pass it.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

import pytest

from src.core.attention.registry_read import (
    MIN_PENDING_VERSION,
    REG_ABSENT,
    REG_BUSY,
    REG_IDLE,
    REG_OK,
    REG_SHELL,
    REG_STALE,
    REG_UNREADABLE,
    REG_WAITING,
    REGISTRY_STALE_AFTER_SECONDS,
    UNREADABLE_KEY_PREFIX,
    parse_registry_record,
    pid_is_running,
    read_registry_index,
    registry_for_session,
    tmux_session_of,
)

# ---------------------------------------------------------------------
# Real payloads, 2026-09-13, claude 2.1.266 unless the version says
# otherwise. ``pid`` is filled in per test so liveness can be controlled.
# ---------------------------------------------------------------------

#: Blocked on an AskUserQuestion menu. This is the shape the "your turn"
#: toast has to fire on and the one the old hook path kept missing.
WAITING_RECORD = {
    "sessionId": "83e263d8-bc64-4bcb-8244-632664f0ecb6",
    "cwd": "/Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode",
    "startedAt": 1789095742551,
    "procStart": "Fri Sep 11 03:02:19 2026",
    "version": "2.1.266",
    "peerProtocol": 1,
    "peerFeatures": ["notify_idle", "reply_across_default_dirs", "artifact_yield"],
    "kind": "interactive",
    "entrypoint": "cli",
    "pidDomain": "darwin",
    "tmux": "cloude_cloudecode-2:@205.%205",
    "messagingSocketPath": "/tmp/cc-socks/51292.sock",
    "name": "fix-false-turn-notifications",
    "nameSource": "auto",
    "nameSince": 1789327656518,
    "status": "waiting",
    "waitingFor": "input needed",
    "updatedAt": 1789327656518,
    "statusUpdatedAt": 1789327655830,
    "bridgeSessionId": None,
}

#: At the prompt with nothing running.
IDLE_RECORD = {
    "sessionId": "f8fa9be5-7b52-40eb-b69f-e198fcb3d393",
    "cwd": "/Users/Adam/Dropbox/Nyedis/Shopify",
    "startedAt": 1789095001000,
    "procStart": "Fri Sep 11 02:50:01 2026",
    "version": "2.1.266",
    "peerProtocol": 1,
    "peerFeatures": ["notify_idle", "reply_across_default_dirs", "artifact_yield"],
    "kind": "interactive",
    "entrypoint": "cli",
    "pidDomain": "darwin",
    "tmux": "cloude_Shopify:@200.%200",
    "name": "Shopify",
    "nameSource": "derived",
    "status": "idle",
    "updatedAt": 1789327000000,
    "statusUpdatedAt": 1789327000000,
    "bridgeSessionId": None,
}

#: Idle apart from a shell command the user started, on an older claude
#: that is still above the pending-count floor.
SHELL_RECORD = {
    "sessionId": "90c5c356-e7d1-4151-b385-78eab7f60f4d",
    "cwd": "/Users/Adam/Dropbox/Nyedis/ADAM-Docs",
    "startedAt": 1788294281973,
    "procStart": "Tue Sep  1 20:24:39 2026",
    "version": "2.1.257",
    "peerProtocol": 1,
    "peerFeatures": ["notify_idle", "reply_across_default_dirs", "artifact_yield"],
    "kind": "interactive",
    "entrypoint": "cli",
    "pidDomain": "darwin",
    "tmux": "cloude_Argent:@154.%154",
    "name": "ADAM-Docs",
    "nameSource": "user",
    "status": "shell",
    "updatedAt": 1789073113338,
    "statusUpdatedAt": 1789073113338,
    "bridgeSessionId": None,
}

#: A claude on somebody else's tmux server. Nothing this app owns is
#: called ``classic``, and the reader must neither claim it nor choke on it.
FOREIGN_RECORD = {
    "sessionId": "92c15491-0997-4956-b949-17c9896abb2f",
    "cwd": "/Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode",
    "startedAt": 1788920722577,
    "procStart": "Wed Sep  9 02:24:16 2026",
    "version": "2.1.266",
    "kind": "interactive",
    "entrypoint": "cli",
    "pidDomain": "darwin",
    "tmux": "classic:@0.%0",
    "name": "cloudecode-be",
    "nameSource": "derived",
    "status": "idle",
    "updatedAt": 1788920722069,
    "statusUpdatedAt": 1788920722069,
    "bridgeSessionId": None,
}

WAITING_TMUX_NAME = "cloude_cloudecode-2"
IDLE_TMUX_NAME = "cloude_Shopify"
SHELL_TMUX_NAME = "cloude_Argent"


def _write_record(directory, payload, *, pid, filename=None) -> int:
    """Write one registry file the way claude writes it.

    Description: stamps ``pid`` into the payload and names the file after
        it, which is the real on-disk convention.
    Inputs:
        directory: a ``tmp_path`` to write into.
        payload: one of the module-level fixture dicts.
        pid: the process id to claim.
        filename: override the filename, to test a name that disagrees
            with the content.
    Output: int - the pid written.
    """
    body = dict(payload)
    body["pid"] = pid
    name = filename if filename is not None else "%d.json" % pid
    (directory / name).write_text(json.dumps(body), encoding="utf-8")
    return pid


def _certainly_dead_pid() -> int:
    """A process id that is measurably not running on this machine.

    Description: does not invent one. macOS caps pids well below 2**22,
        so candidates up there are free, but the value is CONFIRMED with
        the tri-state probe before it is used - a test whose "dead" pid
        was quietly alive would pass for the wrong reason.
    Inputs: none.
    Output: int - a pid for which ``pid_is_running`` answers False.
    """
    for candidate in range(2 ** 22, 2 ** 22 + 256):
        if pid_is_running(candidate) is False:
            return candidate
    pytest.skip("no certainly-dead pid available on this machine")


# ---------------------------------------------------------------------
# The positive controls. Without these, a reader that refused everything
# would pass every other test in this file.
# ---------------------------------------------------------------------


def test_a_live_waiting_record_reads_ok_and_carries_every_field(tmp_path):
    """The green half of the contract: a real file yields a real record."""
    _write_record(tmp_path, WAITING_RECORD, pid=os.getpid())

    record = registry_for_session(
        tmux_name=WAITING_TMUX_NAME, directory=str(tmp_path)
    )

    assert record.verdict == REG_OK
    assert record.known is True
    assert record.status == REG_WAITING
    assert record.waiting_for == "input needed"
    assert record.pid == os.getpid()
    assert record.session_uuid == "83e263d8-bc64-4bcb-8244-632664f0ecb6"
    assert record.tmux_name == WAITING_TMUX_NAME
    assert record.cwd.endswith("/Dev/cloudecode")
    assert record.version == (2, 1, 266)
    assert record.trusts_pending_count is True
    assert record.status_updated_at == datetime.fromtimestamp(
        1789327655830 / 1000.0, tz=timezone.utc
    )
    assert record.started_at.tzinfo is timezone.utc


def test_an_unknown_status_string_is_kept_verbatim_and_not_coerced():
    """A fifth status from a future claude is news, not an error."""
    record = parse_registry_record(
        dict(WAITING_RECORD, status="hibernating", pid=4242), path_pid=4242
    )

    assert record.verdict == REG_OK
    assert record.status == "hibernating"
    assert record.status not in (REG_IDLE, REG_BUSY, REG_WAITING, REG_SHELL)


# ---------------------------------------------------------------------
# The four refusals.
# ---------------------------------------------------------------------


def test_a_missing_registry_directory_reads_absent_and_raises_nothing(tmp_path):
    """No directory is an empty scan and an absent lookup, never a crash."""
    missing = tmp_path / "claude-never-ran-here"

    assert dict(read_registry_index(str(missing))) == {}

    record = registry_for_session(
        tmux_name=WAITING_TMUX_NAME, directory=str(missing)
    )
    assert record.verdict == REG_ABSENT
    assert record.known is False
    assert record.status is None


def test_torn_json_is_unreadable_and_the_scan_continues(tmp_path):
    """One bad file must not cost the reader every other session."""
    _write_record(tmp_path, WAITING_RECORD, pid=os.getpid())
    # A real torn write: claude rewrites this file on every status change
    # and we read it without a lock.
    (tmp_path / "5555.json").write_text('{"pid":5555,"status":"idl', encoding="utf-8")
    (tmp_path / "6666.json").write_text("\x00\x01 not text at all", encoding="utf-8")

    index = read_registry_index(str(tmp_path))

    refusals = [
        record
        for key, record in index.items()
        if key.startswith(UNREADABLE_KEY_PREFIX)
    ]
    assert len(refusals) == 2
    assert all(record.verdict == REG_UNREADABLE for record in refusals)
    assert all(record.status is None for record in refusals)
    # The scan continued: the healthy session is still here.
    assert index[WAITING_TMUX_NAME].verdict == REG_OK


def test_a_dead_pid_is_stale_and_never_ok(tmp_path):
    """A file left behind by a crashed claude is not a live session."""
    dead = _certainly_dead_pid()
    _write_record(tmp_path, IDLE_RECORD, pid=dead)

    record = registry_for_session(tmux_name=IDLE_TMUX_NAME, directory=str(tmp_path))

    assert record.verdict == REG_STALE
    assert record.known is False
    assert record.status is None
    assert "not running" in record.detail


def test_a_record_that_started_before_the_tmux_session_is_stale(tmp_path):
    """tmux names come back; a record older than the name is a previous run."""
    _write_record(tmp_path, WAITING_RECORD, pid=os.getpid())
    started_epoch = WAITING_RECORD["startedAt"] // 1000

    stale = registry_for_session(
        tmux_name=WAITING_TMUX_NAME,
        directory=str(tmp_path),
        session_started_epoch=started_epoch + 60,
    )
    assert stale.verdict == REG_STALE
    assert "previous instance" in stale.detail

    # Positive control: the same record under a floor it clears.
    current = registry_for_session(
        tmux_name=WAITING_TMUX_NAME,
        directory=str(tmp_path),
        session_started_epoch=started_epoch - 60,
    )
    assert current.verdict == REG_OK


def test_a_conversation_uuid_that_disagrees_is_stale_but_a_missing_one_is_not(tmp_path):
    """The conversation gate is one-sided: our column may be behind."""
    _write_record(tmp_path, WAITING_RECORD, pid=os.getpid())

    mismatch = registry_for_session(
        tmux_name=WAITING_TMUX_NAME,
        directory=str(tmp_path),
        claude_session_uuid="00000000-dead-4000-8000-000000000000",
    )
    assert mismatch.verdict == REG_STALE
    assert "names conversation" in mismatch.detail

    agreed = registry_for_session(
        tmux_name=WAITING_TMUX_NAME,
        directory=str(tmp_path),
        claude_session_uuid=WAITING_RECORD["sessionId"],
    )
    assert agreed.verdict == REG_OK

    # We hold no uuid yet. That is not a disagreement.
    unknown = registry_for_session(
        tmux_name=WAITING_TMUX_NAME,
        directory=str(tmp_path),
        claude_session_uuid=None,
    )
    assert unknown.verdict == REG_OK


def test_two_live_records_on_one_tmux_name_refuse_rather_than_pick(tmp_path):
    """No honest tie-break exists, so the key answers unreadable."""
    first = os.getpid()
    second = os.getppid()
    if pid_is_running(second) is not True or second == first:
        pytest.skip("no second live pid available to collide with")

    _write_record(tmp_path, WAITING_RECORD, pid=first)
    _write_record(tmp_path, WAITING_RECORD, pid=second)

    record = read_registry_index(str(tmp_path))[WAITING_TMUX_NAME]

    assert record.verdict == REG_UNREADABLE
    assert record.status is None
    assert str(first) in record.detail and str(second) in record.detail

    # And the lookup passes the refusal through rather than softening it.
    assert (
        registry_for_session(
            tmux_name=WAITING_TMUX_NAME, directory=str(tmp_path)
        ).verdict
        == REG_UNREADABLE
    )


# ---------------------------------------------------------------------
# The version gate.
# ---------------------------------------------------------------------


def test_a_version_below_the_pending_floor_does_not_trust_the_count():
    """Below 2.1.241 the turn-end record has no count to read."""
    below = parse_registry_record(
        dict(IDLE_RECORD, pid=4242, version="2.1.240"), path_pid=4242
    )
    assert below.verdict == REG_OK
    assert below.version < MIN_PENDING_VERSION
    assert below.trusts_pending_count is False

    # Positive control: the older-but-good shell fixture does trust it.
    at_or_above = parse_registry_record(dict(SHELL_RECORD, pid=4242), path_pid=4242)
    assert at_or_above.status == REG_SHELL
    assert at_or_above.trusts_pending_count is True


@pytest.mark.parametrize("version", ["2.1.266-beta.1", "", "nightly", None, 2.1])
def test_an_unparseable_version_does_not_trust_the_count(version):
    """A version we could not read is not evidence of a new enough claude."""
    record = parse_registry_record(
        dict(IDLE_RECORD, pid=4242, version=version), path_pid=4242
    )

    assert record.verdict == REG_OK
    assert record.version is None
    assert record.trusts_pending_count is False


# ---------------------------------------------------------------------
# Scope, splitting and liveness.
# ---------------------------------------------------------------------


def test_a_foreign_tmux_session_is_absent_from_our_lookup(tmp_path):
    """Somebody else's tmux server is read, keyed, and never claimed."""
    _write_record(tmp_path, FOREIGN_RECORD, pid=os.getpid())
    index = read_registry_index(str(tmp_path))

    # It WAS read. Without this the next assertion would pass on an empty
    # scan, which is the check-that-looked-at-nothing shape.
    assert index["classic"].verdict == REG_OK

    record = registry_for_session(
        tmux_name=WAITING_TMUX_NAME, index=index, directory=str(tmp_path)
    )
    assert record.verdict == REG_ABSENT


@pytest.mark.parametrize(
    "target,expected",
    [
        ("cloude_foo:@205.%205", "cloude_foo"),
        ("classic:@0.%0", "classic"),
        ("cloude_Argent-4:@100.%100", "cloude_Argent-4"),
        ("no-colon-here", None),
        (":@0.%0", None),
        ("", None),
        (None, None),
        (12345, None),
    ],
)
def test_tmux_session_of_splits_the_pane_target_and_refuses_the_rest(target, expected):
    """The join is an exact name, so a shape we do not know must answer None."""
    assert tmux_session_of(target) == expected


def test_pid_is_running_is_tri_state_and_never_folds_unknown_into_dead():
    """Unmeasured is not dead: None and False are different answers."""
    assert pid_is_running(os.getpid()) is True
    assert pid_is_running(_certainly_dead_pid()) is False
    # Nothing to measure. A pid of 0 means the whole process group and a
    # negative one means a group, so neither may reach os.kill at all.
    assert pid_is_running(None) is None
    assert pid_is_running(0) is None
    assert pid_is_running(-1) is None


def test_an_old_status_timestamp_is_still_ok_because_the_writer_writes_on_change(
    tmp_path,
):
    """Stale-but-true is the resolver's rule to apply, not the reader's."""
    ancient = int(
        (datetime.now(tz=timezone.utc).timestamp() - REGISTRY_STALE_AFTER_SECONDS * 4)
        * 1000
    )
    _write_record(
        tmp_path,
        dict(SHELL_RECORD, statusUpdatedAt=ancient, updatedAt=ancient),
        pid=os.getpid(),
    )

    record = registry_for_session(tmux_name=SHELL_TMUX_NAME, directory=str(tmp_path))

    assert record.verdict == REG_OK
    assert record.status == REG_SHELL
    assert record.status_updated_at is not None


def test_the_pid_in_the_file_wins_over_the_filename_and_the_clash_is_recorded(tmp_path):
    """The content is what the writer meant; a disagreement is not hidden."""
    _write_record(
        tmp_path, WAITING_RECORD, pid=os.getpid(), filename="999999.json"
    )

    record = registry_for_session(
        tmux_name=WAITING_TMUX_NAME, directory=str(tmp_path)
    )
    assert record.verdict == REG_OK
    assert record.pid == os.getpid()
    assert "disagrees with the filename" in record.detail

    # And with no usable pid in the content, the filename is the fallback.
    fallback = parse_registry_record(
        dict(IDLE_RECORD, pid="not-an-int"), path_pid=7777
    )
    assert fallback.verdict == REG_OK
    assert fallback.pid == 7777


# ---------------------------------------------------------------------
# CAN GO RED. The one that matters most.
# ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        {},
        None,
        [],
        "idle",
        {"pid": 4242},
        {"status": "idle"},
        {"pid": 4242, "status": ""},
        {"pid": True, "status": "idle"},
    ],
)
def test_a_record_with_every_field_missing_is_never_ok_and_never_idle(raw):
    """An empty object must REFUSE, not read as a finished session.

    This is the failure the whole feature exists to remove: a confident
    "done" about a session we know nothing about. Each payload here is
    missing the pid, the status, or both, and every one of them has to
    land on a refusal with no facts attached.
    """
    record = parse_registry_record(raw, path_pid=None)

    assert record.verdict == REG_UNREADABLE
    assert record.known is False
    assert record.status is None
    assert record.status != REG_IDLE
    assert record.pid is None
    assert record.version is None
    assert record.trusts_pending_count is False
    assert record.detail


def test_an_empty_object_on_disk_puts_no_ok_record_in_the_index(tmp_path):
    """The same rule through the real file path, not just the parser."""
    (tmp_path / "1234.json").write_text("{}", encoding="utf-8")

    index = read_registry_index(str(tmp_path))

    assert [record.verdict for record in index.values()] == [REG_UNREADABLE]
    assert registry_for_session(
        tmux_name=IDLE_TMUX_NAME, directory=str(tmp_path)
    ).verdict == REG_ABSENT
