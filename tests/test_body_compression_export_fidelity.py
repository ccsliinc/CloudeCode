"""Compression must not cost one byte of the export guarantee.

WHAT IS BEING PROTECTED. ``message_model_export.export_transcript``
regenerates a transcript's original bytes from the stored parts, and the
join branch verified it file-exact at 400 of 400 real archives against
the archive's own hashes. That guarantee is the whole reason the message
model is allowed to store parsed JSON rather than a second copy of the
file, so a storage change that quietly broke it would cost the corpus.

HOW THIS PROVES IT RATHER THAN ASSUMING IT. The same transcript is
exported TWICE from the SAME database: once with every body stored as
TEXT, and again after ``compress_pending`` has rewritten them. The two
byte strings are compared to each other AND to the original file's bytes.
Comparing only against the file would leave a shared bug in both runs
invisible; comparing only the two runs would pass if both were equally
wrong. Both comparisons, on real bytes, is the test.

AND THE MIDDLE ASSERTION IS THE ONE THAT MAKES IT MEAN ANYTHING: the
storage shape is measured with ``typeof(body_json)`` before and after, so
a ``compress_pending`` that silently did nothing cannot pass this file by
leaving everything as it found it.
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
os.environ.setdefault("DEFAULT_WORKING_DIR", "/tmp")
os.environ.setdefault("LOG_DIRECTORY", "/tmp")
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.corpus_ingest_service import STATUS_OK as INGEST_OK, run_ingest_once
from src.core.db import connect, db_path_for, transaction
from src.core.db_migration import ensure_db_migrated
from src.core.db_steps import apply_message_model_schema
from src.core.message_body_compress import (
    MIN_COMPRESS_CHARS,
    compress_pending,
    pending_compression_count,
    shape_census,
)
from src.core.message_model_export import export_transcript
from src.core.message_projection import STATUS_OK, run_projection_once

SESSION_UUID = "44444444-4444-4444-4444-444444444444"
SLUG = "-Users-x-fidelity"

#: Padding that makes each record comfortably longer than
#: MIN_COMPRESS_CHARS, so the backfill has something to do. Highly
#: repetitive on purpose - a body that does not shrink is left as TEXT by
#: design, and this test is about the rows that DO move.
PAD = "the quick brown fox jumps over the lazy dog " * 12


def _records() -> str:
    """Build a small transcript whose records exercise the awkward shapes.

    Description: non-ASCII, an escaped quote, a nested object whose key
      order is not alphabetical, a content ARRAY and a content STRING.
      Key order and escaping are exactly what byte-exact export is
      sensitive to, so a fixture of plain ASCII would prove very little.
    Inputs: none. Output: str - the file's full text.
    Example: _records().count("\\n") -> 3
    """
    common = (
        '"sessionId":"' + SESSION_UUID + '",'
        '"cwd":"/Users/x/fidelity","gitBranch":"main",'
        '"version":"2.1.263",'
    )
    return (
        '{"type":"user","uuid":"u1",' + common
        + '"timestamp":"2026-08-29T00:00:00.000Z",'
        '"message":{"role":"user","content":"café \\"quoted\\" ' + PAD + '"}}\n'
        '{"type":"assistant","uuid":"a1","parentUuid":"u1",' + common
        + '"timestamp":"2026-08-29T00:00:01.000Z",'
        '"message":{"role":"assistant","model":"claude-test","content":'
        '[{"type":"text","text":"naïve über ' + PAD + '"},'
        '{"type":"tool_use","id":"t1","name":"Bash",'
        '"input":{"command":"echo hi","description":"' + PAD + '"}}]}}\n'
        '{"type":"user","uuid":"u2","parentUuid":"a1",' + common
        + '"timestamp":"2026-08-29T00:00:02.000Z",'
        '"message":{"role":"user","content":'
        '[{"type":"tool_result","tool_use_id":"t1","is_error":false,'
        '"content":"hi ' + PAD + '"}]}}\n'
    )


@pytest.fixture()
def projected(tmp_path: Path, monkeypatch):
    """Ingest and project a real transcript, bodies still TEXT.

    Description: CLOUDE_BODY_COMPRESSION is turned OFF for the ingest, so
      the fixture arrives in the shape an EXISTING install is in - every
      body stored as TEXT, which is what the backfill exists to move. The
      first draft of this file did not do that and the write path had
      already compressed all three bodies before the backfill ran, which
      is correct behaviour and makes a backfill test prove nothing.
    Inputs: tmp_path (Path), monkeypatch.
    Output: (state_dir Path, transcript_id int, original bytes).
    """
    monkeypatch.setenv("CLOUDE_BODY_COMPRESSION", "0")
    state = tmp_path / "state"
    ensure_db_migrated(state, 4, "0.8.2")
    conn = connect(db_path_for(state), create=False)
    try:
        apply_message_model_schema(conn)
        conn.commit()
    finally:
        conn.close()
    corpus = tmp_path / "corpus"
    (corpus / SLUG).mkdir(parents=True)
    source = corpus / SLUG / f"{SESSION_UUID}.jsonl"
    source.write_text(_records(), encoding="utf-8")
    assert run_ingest_once(state, corpus_root=corpus).status == INGEST_OK
    assert run_projection_once(state).status == STATUS_OK
    conn = connect(db_path_for(state), create=False)
    try:
        tid = int(conn.execute(
            "SELECT id FROM message_transcripts ORDER BY id LIMIT 1"
        ).fetchone()[0])
    finally:
        conn.close()
    return state, tid, source.read_bytes()


def _export(state: Path, tid: int) -> bytes:
    """Export one transcript through the real, verifying path.

    Inputs: state (Path), tid (int).
    Output: bytes - the regenerated file.
    Raises: AssertionError - the export did not verify, which is a
      failure of this test rather than something to report and continue.
    """
    conn = connect(db_path_for(state), create=False)
    try:
        result = export_transcript(conn, tid)
    finally:
        conn.close()
    assert result.text is not None, result.detail
    return result.text.encode("utf-8")


def _shapes(state: Path) -> dict:
    """Return the typeof() census for message_bodies.

    Inputs: state (Path). Output: dict.
    """
    conn = connect(db_path_for(state), create=False)
    try:
        return shape_census(conn)
    finally:
        conn.close()


def test_export_is_byte_exact_before_and_after_compression(projected) -> None:
    """The guarantee, measured on both sides of the storage change."""
    state, tid, original = projected

    before = _export(state, tid)
    assert before == original, (
        "the export must already be byte-exact before anything is "
        "compressed, or this test is measuring the wrong thing")

    shapes_before = _shapes(state)
    assert shapes_before.get("text", {}).get("rows", 0) > 0
    assert "blob" not in shapes_before

    conn = connect(db_path_for(state), create=False)
    try:
        pending = pending_compression_count(conn)
        with transaction(conn):
            report = compress_pending(conn)
    finally:
        conn.close()
    assert pending > 0, (
        f"the fixture must hold bodies over {MIN_COMPRESS_CHARS} characters "
        f"for the backfill to have anything to do")
    assert report.rewritten == pending, (
        f"compress_pending rewrote {report.rewritten} of {pending}")

    shapes_after = _shapes(state)
    assert shapes_after.get("blob", {}).get("rows", 0) == report.rewritten, (
        "the rows must actually BE blobs now; a no-op backfill would pass "
        "the byte comparison below trivially")

    after = _export(state, tid)
    assert after == before, "the two exports must agree with each other"
    assert after == original, "and both must equal the original file"
    assert (hashlib.sha256(after).hexdigest()
            == hashlib.sha256(original).hexdigest())


def test_compression_actually_saved_space(projected) -> None:
    """A ratio, so a backfill that stored the text verbatim cannot pass."""
    state, _, _ = projected
    conn = connect(db_path_for(state), create=False)
    try:
        with transaction(conn):
            report = compress_pending(conn)
    finally:
        conn.close()
    assert report.ratio is not None
    assert report.ratio < 0.8, (
        f"this fixture is highly repetitive and must compress well; got "
        f"{report.ratio:.3f}x")


def test_a_second_pass_finds_nothing_left(projected) -> None:
    """Resumability: the work queue IS the data, so a finished pass is idempotent."""
    state, _, _ = projected
    conn = connect(db_path_for(state), create=False)
    try:
        with transaction(conn):
            first = compress_pending(conn)
        with transaction(conn):
            second = compress_pending(conn)
    finally:
        conn.close()
    assert first.rewritten > 0
    assert second.rewritten == 0
    assert second.pending_before == 0


def test_a_bounded_pass_resumes_exactly_where_it_stopped(projected) -> None:
    """An interrupted backfill is a supported state, not a broken one."""
    state, tid, original = projected
    conn = connect(db_path_for(state), create=False)
    try:
        total = pending_compression_count(conn)
        assert total >= 2, "need at least two bodies to stop between them"
        with transaction(conn):
            first = compress_pending(conn, max_rows=1)
        assert first.rewritten == 1
        assert first.pending_after == total - 1
        # Both shapes live in the column at once, and the export still
        # verifies. This IS the no-flag-day claim.
    finally:
        conn.close()
    shapes = _shapes(state)
    assert shapes["text"]["rows"] > 0 and shapes["blob"]["rows"] > 0
    assert _export(state, tid) == original

    conn = connect(db_path_for(state), create=False)
    try:
        with transaction(conn):
            rest = compress_pending(conn)
    finally:
        conn.close()
    assert rest.pending_after == 0
    assert _export(state, tid) == original


def test_the_frame_is_never_stored_when_it_is_not_smaller(
    monkeypatch,
) -> None:
    """encode_if_smaller is a MEASUREMENT, so the frame never costs space.

    Description: the guarantee is a PROPERTY - whatever goes into the
      column is never larger than the text it replaces - so it is
      asserted as one, over inputs including high-entropy ones, rather
      than by hunting for a string zlib cannot shrink. zlib beats any
      text alphabet smaller than 256 symbols, so that hunt does not
      terminate, and a test built on a specific "incompressible" string
      would really be testing that string.

      The losing branch is then forced directly by lowering the
      threshold, which is the only way to reach it deterministically.
      Without that, this test could pass while the comparison had been
      deleted.
    """
    import base64
    import os as _os
    from src.core import message_body_compress as mbc

    samples = [
        "x" * 5000,
        base64.b64encode(_os.urandom(3000)).decode(),
        _os.urandom(2000).hex(),
        "café naïve über " * 300,
        '{"a":1}',
        "",
    ]
    for sample in samples:
        result = mbc.encode_if_smaller(sample)
        stored = (len(result) if isinstance(result, bytes)
                  else len(result.encode("utf-8")))
        assert stored <= len(sample.encode("utf-8")), (
            f"a {len(sample)} character body was stored as {stored} bytes")

    # Force the losing branch: a three-character body cannot beat a
    # 12-byte frame header, so the text must come back unchanged.
    monkeypatch.setattr(mbc, "MIN_COMPRESS_CHARS", 1)
    assert mbc.encode_if_smaller("abc") == "abc"
    # And the control, at the same threshold: something that DOES shrink
    # must still be framed, or the assertion above would pass on a
    # function that had stopped compressing altogether.
    assert isinstance(mbc.encode_if_smaller("y" * 4000), bytes)
