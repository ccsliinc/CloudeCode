"""The cwd read is ONE connection, TWO statements, and never the blob.

WHY A COUNT AND A SUBSTR ASSERTION, NOT A CLOCK. This project has twice
shipped a per-row database open (33 connections for 11 rows, 95 per
listing pass), and the failure both times was a latency tail rather than
a wrong answer. A wall clock on a loaded box either flakes or is too
loose to catch 1 open becoming N. So the COUNT is pinned, and so is the
fact that the statement asks for ``substr(content_gzip, ...)`` rather
than the column - a transcript in this archive reaches 73 MB, and a
regression to ``SELECT content_gzip`` would return the right answer while
reading gigabytes.

The bound is a CONSTANT. Raising it to make a later change pass is
re-introducing the defect with the alarm switched off.
"""

from __future__ import annotations

import sqlite3
import zlib

import pytest

from src.core import archive_cwd_evidence as module
from src.core.archive_cwd_evidence import (
    HEAD_BYTES,
    MAX_ARCHIVES_PER_SLUG,
    REASON_NO_CWD,
    REASON_TRUNCATED,
    REASON_UNREADABLE,
    empty_cwd_index,
    first_recorded_cwd,
    load_archive_cwd_index,
    no_slugs_wanted,
)

#: One open for the whole index, whatever the slug or archive count.
MAX_OPENS_PER_PASS = 1

#: The scan plus the head fetch. A retry adds a third only when the first
#: pass actually failed to parse something.
MAX_STATEMENTS_WITHOUT_RETRY = 2


def _archive_db(path, rows):
    """Build a minimal cloude-archive.db holding only what the reader reads.

    Inputs: path (Path) - the file to create. rows (Sequence[tuple]) -
      (id, source_path, jsonl text, superseded_by_archive_id).
    Output: None.
    """
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE transcript_archives (id INTEGER PRIMARY KEY, "
        "source_path TEXT, content_gzip BLOB, ingested_at TEXT, "
        "superseded_by_archive_id INTEGER)"
    )
    conn.executemany(
        "INSERT INTO transcript_archives (id, source_path, content_gzip, "
        "ingested_at, superseded_by_archive_id) VALUES (?,?,?,?,?)",
        [
            (rid, src, zlib.compress(text.encode("utf-8")), f"2026-01-{rid:02d}",
             sup)
            for rid, src, text, sup in rows
        ],
    )
    conn.commit()
    conn.close()


def _jsonl(cwd, lines=3):
    """A transcript body whose records all carry one cwd."""
    return "".join(
        '{"type":"user","cwd":%s,"i":%d}\n' % (repr(cwd).replace("'", '"'), n)
        for n in range(lines)
    )


@pytest.fixture()
def state_dir(tmp_path, monkeypatch):
    """A state directory whose archive the reader will open."""
    monkeypatch.setattr(
        module, "connect_archive_only",
        lambda sd: _open(sd / "cloude-archive.db"),
    )
    monkeypatch.setattr(
        module, "archive_db_path_for", lambda sd: sd / "cloude-archive.db"
    )
    return tmp_path


def _open(path):
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


class _RecordingConnection(sqlite3.Connection):
    """A real connection that keeps every statement it was handed.

    Description: ``sqlite3.Connection.execute`` cannot be reassigned on
      an instance, so the spy has to be the connection TYPE. Subclassing
      also keeps the statements running for real, which is the point: a
      mock would only prove the arrangement.
    Inputs: as ``sqlite3.Connection``.
    Output: a connection; read ``statements``.
    """

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.statements: list = []

    def execute(self, sql, *args):  # type: ignore[override]
        self.statements.append(sql)
        return super().execute(sql, *args)


class _NotReadOnlyConnection(sqlite3.Connection):
    """A connection whose ``query_only`` pragma silently does not take.

    Description: the failure the read-back exists to catch. Setting a
      pragma is a request; reading 1 is the measurement.
    Inputs: as ``sqlite3.Connection``. Output: a connection.
    """

    def execute(self, sql, *args):  # type: ignore[override]
        if sql == "PRAGMA query_only":
            return super().execute("SELECT 0")
        if sql == "PRAGMA query_only=ON":
            return super().execute("SELECT 1")
        return super().execute(sql, *args)


def test_one_slug_reads_the_cwd_its_transcripts_recorded(state_dir):
    """The happy path: the recorded cwd comes back, underscore intact."""
    _archive_db(
        state_dir / "cloude-archive.db",
        [(1, "-Users-x-my-project/a.jsonl", _jsonl("/Users/x/my_project"), None)],
    )
    index = load_archive_cwd_index(state_dir, ["-Users-x-my-project"])
    assert index.complete is True
    assert index.observed_cwds("-Users-x-my-project") == {"/Users/x/my_project": 1}
    assert index.archives_inspected("-Users-x-my-project") == 1


def test_a_slug_nobody_asked_about_is_not_read(state_dir):
    """Only the wanted slugs are answered, so the cost is the caller's."""
    _archive_db(
        state_dir / "cloude-archive.db",
        [
            (1, "-Users-x-wanted/a.jsonl", _jsonl("/Users/x/wanted"), None),
            (2, "-Users-x-other/b.jsonl", _jsonl("/Users/x/other"), None),
        ],
    )
    index = load_archive_cwd_index(state_dir, ["-Users-x-wanted"])
    assert index.observed_cwds("-Users-x-other") == {}
    assert index.slugs_held == 1


def test_a_superseded_archive_is_skipped(state_dir):
    """Its body is a sentinel, so reading it would report a missing cwd."""
    _archive_db(
        state_dir / "cloude-archive.db",
        [
            (1, "-Users-x-p/a.jsonl", "", 2),
            (2, "-Users-x-p/a.jsonl", _jsonl("/Users/x/p"), None),
        ],
    )
    index = load_archive_cwd_index(state_dir, ["-Users-x-p"])
    assert index.observed_cwds("-Users-x-p") == {"/Users/x/p": 1}
    assert index.archives_inspected("-Users-x-p") == 1


def test_no_slugs_wanted_opens_nothing_and_is_still_complete(monkeypatch, tmp_path):
    """A listing the app database fully named must not pay a connection.

    The same "skip the read when nothing can use it" rule InstanceIndex
    follows. ``complete`` is True because the question really was
    answered: there was none.
    """
    def explode(*_args, **_kwargs):
        raise AssertionError("opened a connection for an empty question")

    monkeypatch.setattr(module, "connect_archive_only", explode)
    monkeypatch.setattr(module, "connect", explode)
    index = load_archive_cwd_index(tmp_path, [])
    assert index.complete is True
    assert index.slugs_held == 0
    assert no_slugs_wanted().complete is True


def test_one_connection_regardless_of_slug_count(state_dir, monkeypatch):
    """The whole point: it does not grow with the number of slugs."""
    rows = [
        (n, f"-Users-x-p{n}/a.jsonl", _jsonl(f"/Users/x/p{n}"), None)
        for n in range(1, 41)
    ]
    _archive_db(state_dir / "cloude-archive.db", rows)
    opens = []
    real = module.connect_archive_only

    def spy(sd):
        opens.append(sd)
        return real(sd)

    monkeypatch.setattr(module, "connect_archive_only", spy)
    index = load_archive_cwd_index(
        state_dir, [f"-Users-x-p{n}" for n in range(1, 41)]
    )
    assert index.slugs_held == 40
    assert len(opens) <= MAX_OPENS_PER_PASS


def test_the_body_is_never_selected_whole(state_dir, monkeypatch):
    """``substr`` is the whole cost model; SELECT content_gzip is the bug.

    Asserted on the SQL actually executed rather than on a timing,
    because a small fixture would run fast either way and prove nothing.
    """
    _archive_db(
        state_dir / "cloude-archive.db",
        [(1, "-Users-x-p/a.jsonl", _jsonl("/Users/x/p"), None)],
    )
    made = []

    def spy(sd):
        conn = sqlite3.connect(
            str(sd / "cloude-archive.db"), factory=_RecordingConnection
        )
        conn.row_factory = sqlite3.Row
        made.append(conn)
        return conn

    monkeypatch.setattr(module, "connect_archive_only", spy)
    load_archive_cwd_index(state_dir, ["-Users-x-p"])
    seen = [sql for conn in made for sql in conn.statements]
    body_reads = [s for s in seen if "content_gzip" in s]
    assert body_reads, "the body was never read at all"
    for sql in body_reads:
        assert "substr(content_gzip" in sql, sql
    scans = [s for s in seen if "FROM transcript_archives" in s]
    assert len(scans) <= MAX_STATEMENTS_WITHOUT_RETRY


def test_the_cap_is_reported_rather_than_silently_sampled(state_dir):
    """A capped reading cannot prove a conflict absent, so it says so."""
    over = MAX_ARCHIVES_PER_SLUG + 3
    rows = [
        (n, "-Users-x-p/a.jsonl", _jsonl("/Users/x/p"), None)
        for n in range(1, over + 1)
    ]
    _archive_db(state_dir / "cloude-archive.db", rows)
    index = load_archive_cwd_index(state_dir, ["-Users-x-p"])
    assert index.was_capped("-Users-x-p") is True
    assert index.archives_inspected("-Users-x-p") == MAX_ARCHIVES_PER_SLUG


def test_a_truncated_first_record_is_retried_at_a_larger_head(state_dir):
    """Measured on live: 896 archives need this at 4 KB, 6 still fail at 16 KB.

    The retry is not insurance against a case nobody has seen; it is the
    difference between 19,309 and 20,212 answered archives.
    """
    padding = "x" * (HEAD_BYTES * 3)
    body = '{"type":"user","note":"%s","cwd":"/Users/x/p"}\n' % padding
    _archive_db(
        state_dir / "cloude-archive.db",
        [(1, "-Users-x-p/a.jsonl", body, None)],
    )
    index = load_archive_cwd_index(state_dir, ["-Users-x-p"])
    assert index.observed_cwds("-Users-x-p") == {"/Users/x/p": 1}


def test_a_record_with_no_cwd_is_a_different_answer_from_an_unreadable_one():
    """Two empty answers, two reasons, and only one is worth a retry."""
    assert first_recorded_cwd(None) == (None, REASON_UNREADABLE)
    assert first_recorded_cwd(b"not zlib at all") == (None, REASON_UNREADABLE)
    no_cwd = zlib.compress(b'{"type":"summary"}\n')
    assert first_recorded_cwd(no_cwd) == (None, REASON_NO_CWD)
    truncated = zlib.compress(b'{"type":"user","cwd":"/Users/x/p"')
    assert first_recorded_cwd(truncated) == (None, REASON_TRUNCATED)


def test_the_first_record_wins_because_a_session_can_change_directory():
    """Claude Code rewrites cwd on a mid-conversation ``cd``.

    The directory a transcript was FILED under is the one it started in,
    so a later record must not displace it.
    """
    body = (
        '{"type":"user","cwd":"/Users/x/p"}\n'
        '{"type":"user","cwd":"/Users/x/p/deep/inside"}\n'
    )
    cwd, reason = first_recorded_cwd(zlib.compress(body.encode()))
    assert (cwd, reason) == ("/Users/x/p", "ok")


def test_an_unopenable_archive_says_it_could_not_look(monkeypatch, tmp_path):
    """Never ``none``: nobody looked, which is the opposite finding."""
    def refuse(*_args, **_kwargs):
        raise sqlite3.OperationalError("unable to open database file")

    monkeypatch.setattr(module, "connect_archive_only", refuse)
    monkeypatch.setattr(module, "connect", refuse)
    index = load_archive_cwd_index(tmp_path, ["-Users-x-p"])
    assert index.complete is False
    assert empty_cwd_index().complete is False


def test_a_connection_that_will_not_go_read_only_is_refused(state_dir, monkeypatch):
    """The live archive has an ingester writing it, so this is not a formality."""
    _archive_db(
        state_dir / "cloude-archive.db",
        [(1, "-Users-x-p/a.jsonl", _jsonl("/Users/x/p"), None)],
    )
    def spy(sd):
        conn = sqlite3.connect(
            str(sd / "cloude-archive.db"), factory=_NotReadOnlyConnection
        )
        conn.row_factory = sqlite3.Row
        return conn

    monkeypatch.setattr(module, "connect_archive_only", spy)
    assert load_archive_cwd_index(state_dir, ["-Users-x-p"]).complete is False
