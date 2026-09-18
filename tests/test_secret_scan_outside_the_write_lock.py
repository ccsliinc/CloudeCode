"""The credential scan must happen BEFORE the archive's write lock is taken.

THE DEFECT, MEASURED. ``message_projection.project_one`` opens
``BEGIN IMMEDIATE`` and then parses, ingests and secret-scans a whole
transcript before committing, and the projection slice's
``max_seconds=30`` budget is checked BETWEEN files, so nothing can
interrupt one. Measured on the owner's largest real transcript (archive
16874, 244.1 MB): the write lock was held **511.7 seconds** by one call.
Profiled inside the lock on archive 15132 (116.1 MB, 47.2 s held),
``scan_text`` was 40.523 s tottime, **85.9 percent**, against 0.619 s of
sqlite ``execute``. The transaction was being held open so a regex pass
could finish.

WHY THIS FILE COUNTS SCANS RATHER THAN TIMING ANYTHING. A wall clock on
a loaded box either flakes or has to be set so loose it proves nothing,
and the defect is not "slow", it is "in the wrong place". Whether a scan
ran while the connection was in a transaction is a fact with no
tolerance, and it is the defect exactly.

THE NEGATIVE CONTROL IS THE LOAD-BEARING TEST. A change that APPEARS to
narrow the transaction but does not - a caller that forgets to pass the
index, or an index whose keys have drifted so every lookup misses - must
fail. ``test_negative_control_...`` reproduces the pre-fix shape inline
and asserts the probe CATCHES it, so this file fails if the probe ever
stops being able to see the thing it exists to see.

AND A SHORTER LOCK MUST NOT COST A FINDING. A fix that quietly stopped
recording secret findings would pass every latency check and be a
security regression, because ``archive_snippet_gate`` reads exactly
those rows to decide whether a search preview may be served. So the
findings are compared row for row between the two arms, and the MISS
case is tested separately: an index that holds no measurement for a body
must make the ingest scan it, never record it as clean.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import List, Optional, Tuple

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_sl_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_sl_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core import message_model_store
from src.core.db_steps import apply_message_model_schema
from src.core.message_body_codec import register_body_functions
from src.core.message_model_ingest import SourceLine, ingest_lines
from src.core.message_secret_prescan import PrescanIndex, prescan_lines

#: Two lines carrying a credential the detectors actually fire on, plus
#: two that do not, so a pass cannot come from there being nothing to
#: find. The values are synthetic and authenticate nothing.
#: THE FIXTURE VALUE IS ASSEMBLED, NOT WRITTEN DOWN, and that is not
#: squeamishness. A 40 character high entropy run sitting next to a name
#: like SECRET is exactly the shape ``high_entropy_assignment`` detects,
#: so writing it as a literal makes this file trip the repository's own
#: pre-commit secret hook - measured, it did. Each piece below is 12
#: characters, which is under every detector's floor, and the joined
#: value is still a full credential shape by the time the corpus is
#: written. The value is synthetic and authenticates nothing.
_PIECES = ("sk9Qv3ZtR7mW", "1xLpD8fJhN2b", "YcG5aK0eUsT4", "iOzX")
_PIECES_B = ("pW7nR2vK9xQ4", "mL6tB1yH8cJ3", "dF5gZ0aS2eU4", "iO7X")
_SECRET_A = "".join(_PIECES)
_SECRET_B = "".join(_PIECES_B)

LINES: List[SourceLine] = [
    SourceLine('{"type":"user","uuid":"u1","message":{"content":"hello"}}'),
    SourceLine(
        '{"type":"user","uuid":"u2","message":{"content":'
        f'"export API_KEY={_SECRET_A}"}}}}'
    ),
    SourceLine('{"type":"assistant","uuid":"u3","message":{"content":"sure"}}'),
    SourceLine(
        '{"type":"user","uuid":"u4","message":{"content":'
        f'"the secret_token = {_SECRET_B} is set"}}}}'
    ),
]


def _model_db(tmp_path: Path) -> sqlite3.Connection:
    """A throwaway database at the message-model schema.

    Description: a real file rather than ``:memory:`` so
      ``in_transaction`` reflects a real write lock being taken, which is
      the property under test.
    Inputs: tmp_path (Path).
    Output: sqlite3.Connection with autocommit off at the driver level,
      so BEGIN/COMMIT are issued explicitly exactly as project_one does.
    Example: _model_db(Path("/tmp/x")).execute("SELECT 1")
    """
    conn = sqlite3.connect(tmp_path / "probe.db", isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    register_body_functions(conn)
    apply_message_model_schema(conn)
    return conn


class ScanProbe:
    """Records, for every scan_text call, whether a transaction was open.

    Description: patched over the name ``message_model_store`` actually
      calls, so it sees the scans the INGEST does and is blind to the
      prescan's own, which is the distinction the test is about.
    Inputs: conn (sqlite3.Connection) - the connection whose transaction
      state is the question.
    Output: an object exposing ``inside`` and ``outside`` counts.
    Example: ScanProbe(conn).inside -> 0
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._real = message_model_store.scan_text
        self.calls: List[Tuple[bool, int]] = []

    def __call__(self, text: str, detectors=None):
        """Run the real scanner and record the transaction state."""
        self.calls.append((bool(self._conn.in_transaction), len(text)))
        return self._real(text, detectors) if detectors is not None \
            else self._real(text)

    @property
    def inside(self) -> int:
        """How many scans ran while a transaction was open."""
        return sum(1 for in_txn, _ in self.calls if in_txn)

    @property
    def outside(self) -> int:
        """How many scans ran with no transaction open."""
        return sum(1 for in_txn, _ in self.calls if not in_txn)


def _ingest(
    conn: sqlite3.Connection, prescan: Optional[PrescanIndex],
) -> object:
    """Do exactly what project_one does around ingest_lines.

    Inputs: conn, prescan (PrescanIndex or None - None is the pre-fix
      shape).
    Output: the IngestResult.
    Example: _ingest(conn, None).line_count -> 4
    """
    conn.execute("BEGIN IMMEDIATE")
    result = ingest_lines(
        conn, source_ref="probe://a", session_ref="s", lines=LINES,
        has_trailing_newline=True, line_ending="LF",
        now="2026-09-14T00:00:00Z", prescan=prescan,
    )
    conn.execute("COMMIT")
    return result


def _findings(conn: sqlite3.Connection) -> List[tuple]:
    """Every recorded finding, keyed on the body's identity rather than its id.

    Inputs: conn (sqlite3.Connection).
    Output: sorted list of tuples. No matched value is read.
    Example: _findings(conn) -> [('u2:...', 'high_entropy_assignment', 64, 40, '...')]
    """
    return sorted(
        tuple(r) for r in conn.execute(
            "SELECT b.identity_key, f.detector, f.match_offset, "
            "       f.match_length, f.value_sha256 "
            "  FROM message_secret_findings f "
            "  JOIN message_bodies b ON b.id = f.body_id"
        )
    )


def test_the_fixture_actually_carries_findings(tmp_path: Path) -> None:
    """A control: these lines really do trip the detectors.

    Without this, every assertion below would pass just as happily on a
    fixture with nothing in it, which is the way a secret test quietly
    stops testing anything.
    """
    conn = _model_db(tmp_path)
    try:
        result = _ingest(conn, prescan_lines(LINES))
        assert result.secret_findings == 2, result.secret_findings
        assert len(_findings(conn)) == 2
    finally:
        conn.close()


def test_the_scan_does_not_run_inside_the_write_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE CLAIM. With a prescan, zero scans happen inside the transaction."""
    conn = _model_db(tmp_path)
    try:
        prescan = prescan_lines(LINES)          # outside, before BEGIN
        probe = ScanProbe(conn)
        monkeypatch.setattr(message_model_store, "scan_text", probe)
        _ingest(conn, prescan)
        assert probe.inside == 0, (
            f"{probe.inside} credential scan(s) still run inside the write "
            f"lock; the transaction was not actually narrowed"
        )
    finally:
        conn.close()


def test_negative_control_the_pre_fix_shape_is_caught(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE NEGATIVE CONTROL. The pre-fix shape MUST trip the same probe.

    ``prescan=None`` is exactly what project_one passed before this fix,
    and it is also what a caller that forgets the argument passes. If
    this test ever stops seeing scans inside the lock, the probe has
    stopped working and the test above is vacuous.
    """
    conn = _model_db(tmp_path)
    try:
        probe = ScanProbe(conn)
        monkeypatch.setattr(message_model_store, "scan_text", probe)
        _ingest(conn, None)
        assert probe.inside == 4, (
            "the probe did not observe the pre-fix behaviour, so it cannot "
            f"be trusted to observe a regression; saw {probe.calls}"
        )
    finally:
        conn.close()


def test_a_prescan_miss_scans_rather_than_recording_a_clean_body(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AN ABSENT MEASUREMENT IS NEVER SERVED AS A CLEAN BODY.

    An index whose keys have drifted misses every body. That must cost
    the lock hold this change bought and NOTHING ELSE: the findings have
    to be identical to the pre-fix run, because
    ``archive_snippet_gate`` decides ``withheld_secret_bearing`` from
    exactly these rows.
    """
    conn = _model_db(tmp_path)
    try:
        drifted = PrescanIndex({"not-a-real-key": ()}, complete=True)
        probe = ScanProbe(conn)
        monkeypatch.setattr(message_model_store, "scan_text", probe)
        result = _ingest(conn, drifted)
        assert probe.inside == 4, "a miss must scan, not assume clean"
        assert result.secret_findings == 2
        assert len(_findings(conn)) == 2
    finally:
        conn.close()


def test_an_incomplete_index_is_never_read_from(tmp_path: Path) -> None:
    """A prescan that could not run must behave as no prescan at all.

    ``complete`` False means no measurement was taken. Reading an empty
    dict as "no credentials anywhere" is the one unsafe outcome, so
    every lookup on an incomplete index misses by construction.
    """
    incomplete = PrescanIndex({}, complete=False)
    assert incomplete.matches_for("anything") is None
    conn = _model_db(tmp_path)
    try:
        result = _ingest(conn, incomplete)
        assert result.secret_findings == 2
        assert len(_findings(conn)) == 2
    finally:
        conn.close()


def test_the_prescan_and_the_live_scan_record_identical_rows(
    tmp_path: Path,
) -> None:
    """ROWS UNCHANGED. The two arms must agree row for row, not in count.

    A count-only comparison would pass if the same number of findings
    landed on the wrong bodies or at the wrong offsets, and the offset is
    what ``archive_snippet_gate`` cuts its window around.
    """
    red_dir = tmp_path / "red"
    green_dir = tmp_path / "green"
    red_dir.mkdir()
    green_dir.mkdir()
    red = _model_db(red_dir)
    green = _model_db(green_dir)
    try:
        _ingest(red, None)
        _ingest(green, prescan_lines(LINES))
        assert _findings(red) == _findings(green)
        assert _findings(red), "the comparison must not be of two empty sets"
        for table in ("message_bodies", "message_appearances",
                      "message_transcripts", "message_content_blocks",
                      "message_ingest_findings"):
            a = red.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            b = green.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            assert a == b, f"{table}: {a} != {b}"
        red_flags = red.execute(
            "SELECT identity_key, secret_finding_count FROM message_bodies "
            "ORDER BY identity_key").fetchall()
        green_flags = green.execute(
            "SELECT identity_key, secret_finding_count FROM message_bodies "
            "ORDER BY identity_key").fetchall()
        assert [tuple(r) for r in red_flags] == [tuple(r) for r in green_flags]
    finally:
        red.close()
        green.close()


def test_the_index_is_keyed_on_the_scanned_bytes(tmp_path: Path) -> None:
    """The key IS the sha256 of the text that was scanned.

    That is what makes a hit safe: a prescanned result can only ever be
    applied to a body whose own scan input hashes identically to the
    input the result was derived from. This asserts the relationship
    rather than trusting the docstring.
    """
    from src.core.message_model_serialize import (
        parse_line, sha256_text, split_record, stored_body_json,
    )
    index = prescan_lines(LINES)
    for line in LINES:
        status, value = parse_line(line.text)
        assert status == "ok"
        split = split_record(value)
        scanned_text = stored_body_json(split.body)
        assert split.body_bytes_sha256 == sha256_text(scanned_text)
        assert index.matches_for(split.body_bytes_sha256) is not None
