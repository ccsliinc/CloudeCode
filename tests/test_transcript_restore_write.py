"""The writer: it lands the right bytes, and it refuses the wrong places.

THE DECISIVE TEST IN THIS FILE IS
:func:`test_the_home_write_guard_refuses_the_real_corpus_path`. Everything
else proves the writer works; that one proves it cannot be pointed at the
developer's own ``~/.claude/projects`` from inside a test run, which is
the failure mode that would cost a real person real conversations.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_trw_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_trw_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

from src.core.transcript_restore_outcomes import (
    REFUSED_BY_TEST_GUARD,
    VERIFY_AFTER_WRITE_FAILED,
    WRITE_FAILED,
    WRITTEN,
)
from src.core.transcript_restore_write import BACKUP_SUFFIX, write_transcript

PAYLOAD = b'{"type":"user","cwd":"/Users/x/Proj"}\n{"type":"assistant"}\n'
PAYLOAD_SHA = hashlib.sha256(PAYLOAD).hexdigest()


def test_it_writes_the_exact_bytes_and_proves_it(tmp_path: Path) -> None:
    """Byte-exact, and the verdict rests on a read-back, not on no-exception."""
    target = tmp_path / "-Users-x-Proj" / "abc.jsonl"
    target.parent.mkdir(parents=True)
    result = write_transcript(target, PAYLOAD, PAYLOAD_SHA)
    assert result.outcome == WRITTEN
    assert target.read_bytes() == PAYLOAD
    assert result.verified_sha256 == PAYLOAD_SHA
    assert result.bytes_written == len(PAYLOAD)


def test_no_temp_file_is_left_beside_the_target(tmp_path: Path) -> None:
    """The atomic dance cleans up after itself."""
    target = tmp_path / "abc.jsonl"
    write_transcript(target, PAYLOAD, PAYLOAD_SHA)
    leftovers = [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


def test_an_existing_file_is_refused_without_the_opt_in(tmp_path: Path) -> None:
    """NEGATIVE CONTROL. Two gates in front of one irreversible act."""
    target = tmp_path / "abc.jsonl"
    target.write_bytes(b"live conversation\n")
    result = write_transcript(target, PAYLOAD, PAYLOAD_SHA)
    assert result.outcome == WRITE_FAILED
    assert target.read_bytes() == b"live conversation\n"


def test_the_opt_in_replaces_the_file_and_backs_the_old_bytes_up(
    tmp_path: Path,
) -> None:
    """The .bak is written BEFORE the replace, so the old bytes survive."""
    target = tmp_path / "abc.jsonl"
    target.write_bytes(b"old\n")
    result = write_transcript(target, PAYLOAD, PAYLOAD_SHA, allow_overwrite=True)
    assert result.outcome == WRITTEN
    assert target.read_bytes() == PAYLOAD
    backup = target.with_name(target.name + BACKUP_SUFFIX)
    assert backup.read_bytes() == b"old\n"
    assert result.backup_path == backup


def test_a_wrong_expected_hash_is_caught_after_the_write(tmp_path: Path) -> None:
    """NEGATIVE CONTROL for the read-back.

    A writer that reported success from the absence of an exception would
    pass every other test in this file. This one hands it bytes that do
    not match the hash it was told to expect, which is exactly what a
    corrupted reconstruction reaching the writer would look like.
    """
    target = tmp_path / "abc.jsonl"
    result = write_transcript(target, PAYLOAD, "0" * 64)
    assert result.outcome == VERIFY_AFTER_WRITE_FAILED
    assert result.verified_sha256 == PAYLOAD_SHA


def test_create_dirs_is_required_to_make_a_project_directory(tmp_path: Path) -> None:
    """Without it the OSError is reported by name, not raised at the caller."""
    target = tmp_path / "-Users-x-Gone" / "abc.jsonl"
    assert write_transcript(target, PAYLOAD, PAYLOAD_SHA).outcome == WRITE_FAILED
    assert not target.exists()
    result = write_transcript(target, PAYLOAD, PAYLOAD_SHA, create_dirs=True)
    assert result.outcome == WRITTEN
    assert target.read_bytes() == PAYLOAD


def test_the_home_write_guard_refuses_the_real_corpus_path() -> None:
    """THE DECISIVE TEST. A test run cannot reach ~/.claude/projects.

    This calls the PRODUCTION writer with the PRODUCTION default
    destination. No fixture redirects it and nothing is mocked: the
    refusal has to come from
    ``src.core.test_write_guard.assert_test_write_allowed`` inside
    ``write_transcript`` itself, which is the only layer a test that
    constructs its own paths cannot bypass.

    Watched go red by removing the guard call from ``write_transcript``:
    this test then WRITES A FILE into the developer's real corpus, which
    is precisely the defect the guard exists for.
    """
    from src.core.transcript_restore_target import default_corpus_root

    target = default_corpus_root() / "-cloude-guard-probe" / "must-never-exist.jsonl"
    result = write_transcript(target, PAYLOAD, PAYLOAD_SHA, create_dirs=True)
    assert result.outcome == REFUSED_BY_TEST_GUARD
    assert not target.exists()
    assert not target.parent.exists(), "the guard must refuse BEFORE any mkdir"


def test_the_guard_refuses_before_the_backup_too(tmp_path: Path) -> None:
    """The overwrite path is guarded on the same call, not on a later one."""
    outside = Path(os.path.expanduser("~")) / ".cloude-restore-guard-probe.jsonl"
    result = write_transcript(outside, PAYLOAD, PAYLOAD_SHA, allow_overwrite=True)
    assert result.outcome == REFUSED_BY_TEST_GUARD
    assert not outside.exists()
    assert not outside.with_name(outside.name + BACKUP_SUFFIX).exists()


def test_a_writer_that_always_succeeded_would_fail_this_file(tmp_path: Path) -> None:
    """The load-bearing assertion: this writer can and does say no.

    Four distinct refusals, four distinct names. A writer that returned
    WRITTEN unconditionally passes the happy path and fails here.
    """
    existing = tmp_path / "taken.jsonl"
    existing.write_bytes(b"live\n")
    outcomes = [
        write_transcript(existing, PAYLOAD, PAYLOAD_SHA).outcome,
        write_transcript(tmp_path / "no" / "dir.jsonl", PAYLOAD, PAYLOAD_SHA).outcome,
        write_transcript(tmp_path / "bad.jsonl", PAYLOAD, "f" * 64).outcome,
        write_transcript(
            Path(os.path.expanduser("~")) / ".cloude-probe2.jsonl",
            PAYLOAD,
            PAYLOAD_SHA,
        ).outcome,
    ]
    assert WRITTEN not in outcomes
    assert set(outcomes) == {
        WRITE_FAILED,
        VERIFY_AFTER_WRITE_FAILED,
        REFUSED_BY_TEST_GUARD,
    }
