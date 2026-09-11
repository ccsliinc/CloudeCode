"""The pipe-trim primitive, exercised without tmux.

The real-tmux file beside this one proves that a rotation keeps a live
pane streaming. This one proves the primitive underneath it against a
REAL file and a REAL ``O_APPEND`` writer, so the heart of the fix is
still covered on a machine with no tmux binary.

The writer here is a plain ``os.open(..., O_APPEND)``, which is exactly
what a shell's ``>>`` produces. That is the precondition the whole
approach rests on: with ``O_APPEND`` every write seeks to the current
end of file first, so a truncate to zero sends the next write to offset
0. Without it the writer would keep its own offset and re-create the
file at its old length as a hole.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.pipe_rotation import rotation_reason, truncate_in_place


def test_rotation_reason_leaves_a_file_under_both_ceilings_alone():
    """Neither ceiling crossed means no trim."""
    assert rotation_reason(9, 1.0, 10, 24.0) is None


def test_rotation_reason_is_strictly_greater_than_not_equal():
    """A file sitting exactly ON the ceiling is not over it.

    Pinned because a boundary that quietly became ``>=`` would trim on
    every check for a file parked at the threshold.
    """
    assert rotation_reason(10, 24.0, 10, 24.0) is None
    assert rotation_reason(11, 24.0, 10, 24.0) == "size"
    assert rotation_reason(10, 24.1, 10, 24.0) == "age"


def test_rotation_reason_reports_size_when_both_apply():
    """Size wins the report, because size is what bounds disk."""
    assert rotation_reason(999, 999.0, 10, 24.0) == "size"


@pytest.fixture
def pipe(tmp_path):
    """Provide a file, an O_APPEND writer fd, and a reader fd on it.

    Output: tuple of (path, write_fd, read_fd), all closed on teardown.
    """
    path = tmp_path / "probe.pipe"
    path.touch()
    write_fd = os.open(str(path), os.O_WRONLY | os.O_APPEND)
    read_fd = os.open(str(path), os.O_RDONLY | os.O_NONBLOCK)
    try:
        yield path, write_fd, read_fd
    finally:
        os.close(write_fd)
        os.close(read_fd)


def _read_all(fd: int) -> bytes:
    """Drain a non-blocking descriptor to EOF."""
    out = b""
    while True:
        try:
            chunk = os.read(fd, 4096)
        except BlockingIOError:
            break
        if not chunk:
            break
        out += chunk
    return out


def test_reader_follows_the_trim_and_repeats_nothing(pipe):
    """After a trim the reader sees new bytes, and only new bytes.

    This is the defect and its fix in one assertion pair. Truncating
    without the re-seek leaves the reader parked past the new end of
    file, where it reads EOF until the writer produces as many bytes
    again; re-seeking without the truncate replays what was already
    sent.
    """
    path, write_fd, read_fd = pipe

    os.write(write_fd, b"FIRST_GENERATION_BYTES\n")
    assert _read_all(read_fd) == b"FIRST_GENERATION_BYTES\n"

    assert truncate_in_place(path, read_fd) is True
    assert path.stat().st_size == 0

    os.write(write_fd, b"SECOND_GENERATION_BYTES\n")
    after = _read_all(read_fd)

    assert after == b"SECOND_GENERATION_BYTES\n", (
        "the reader did not land on the trimmed file's first byte"
    )
    assert b"FIRST_GENERATION_BYTES" not in after, (
        "the reader replayed output it had already delivered"
    )


def test_unread_bytes_are_the_callers_problem_not_a_silent_replay(pipe):
    """A trim destroys unread bytes rather than replaying them later.

    Stated as a test because it is the accepted cost of trimming in
    place, and the caller drains to EOF first precisely to keep this
    window to a single ``truncate(2)``. If this ever started passing
    the old bytes through, the reader would be emitting a fragment of
    the previous generation after the trim.
    """
    path, write_fd, read_fd = pipe

    os.write(write_fd, b"NEVER_READ_BEFORE_TRIM\n")
    assert truncate_in_place(path, read_fd) is True

    os.write(write_fd, b"POST_TRIM\n")
    assert _read_all(read_fd) == b"POST_TRIM\n"


def test_the_writers_offset_restarts_at_zero(pipe):
    """An O_APPEND writer refills from the start, leaving no hole.

    The measured precondition, asserted rather than assumed. A writer
    holding its own offset would re-create the file at its old length,
    so the trim would reclaim nothing.
    """
    path, write_fd, read_fd = pipe

    os.write(write_fd, b"x" * 5000)
    assert path.stat().st_size == 5000

    assert truncate_in_place(path, read_fd) is True
    os.write(write_fd, b"y" * 10)

    assert path.stat().st_size == 10, (
        "the file re-grew to its old length, so the writer is not O_APPEND"
    )


def test_a_missing_file_refuses_instead_of_raising(tmp_path):
    """A vanished pipe file is reported, not raised into the tail loop.

    The caller leaves its rotation stamp alone on a False, so the next
    check retries rather than the reader task dying.
    """
    missing = tmp_path / "gone.pipe"
    real = tmp_path / "real.pipe"
    real.touch()
    read_fd = os.open(str(real), os.O_RDONLY)
    try:
        assert truncate_in_place(missing, read_fd) is False
    finally:
        os.close(read_fd)


def test_a_closed_reader_refuses_after_the_truncate(tmp_path):
    """A bad descriptor is reported, and never as success.

    The file is genuinely trimmed by the time the re-seek runs, so
    returning True here would tell the caller the reader was repositioned
    when it was not.
    """
    path = tmp_path / "probe.pipe"
    path.write_bytes(b"some bytes")
    read_fd = os.open(str(path), os.O_RDONLY)
    os.close(read_fd)

    assert truncate_in_place(path, read_fd) is False
    assert path.stat().st_size == 0
