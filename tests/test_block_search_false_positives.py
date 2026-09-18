"""THE TEST THAT PINS THE DEFECT: a metadata token is not a message hit.

THIS IS THE LOAD-BEARING FILE OF THE WHOLE SEARCH CHANGE, and the reason
is that a test asserting HITS would pass today. ``archive_search`` used to
match ``INSTR(body_json, needle)`` and ``body_json`` is the ENTIRE jsonl
record - ``cwd``, ``sessionId``, ``parentUuid``, ``timestamp``,
``gitBranch``, ``entrypoint``, ``version``, ``promptId`` and the message
together - so searching for a model name matched the envelope of every
message that model produced. Measured on the 400-transcript projection,
2026-09-13: ``claude-opus-4`` returned 33,805 bodies, of which 165 carry
it in real message text. ``"cache_read_input_tokens"`` returned 91,623
against 30.

So the assertion here is a ZERO, and it is asserted next to a POSITIVE
CONTROL on the same corpus in the same test, because a search that found
nothing at all would satisfy the zero perfectly. The pair is the test; the
zero alone is not.

``test_the_old_matcher_would_have_returned_a_false_positive`` runs the
PRE-FIX SQL inline against the same rows. Without it this file would only
prove that the new search agrees with itself - it could not tell "the
defect is fixed" from "this fixture never had the defect". WATCHED RED
against the base commit before it was trusted green.

Nothing is mocked. Real .jsonl files, the real ingester, the real
projection, the real block extractor, the real index build and the real
``search_scoped``.
"""

from __future__ import annotations

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
from src.core import archive_search
from src.core.corpus_ingest_service import STATUS_OK as INGEST_OK, run_ingest_once
from src.core.db import connect, db_path_for, transaction
from src.core.db_migration import ensure_db_migrated
from src.core.db_steps import apply_message_model_schema
from src.core.message_block_search_index import build_pending, reset_index
from src.core.message_projection import STATUS_OK, run_projection_once

SESSION_UUID = "33333333-3333-3333-3333-333333333333"
SLUG = "-Users-x-falsepositive"

#: Appears ONLY in the envelope: it is the value of ``message.model`` and
#: of ``version``. No message text in this corpus contains it. This is
#: the needle the old matcher answered 33,805 times on the real corpus.
METADATA_NEEDLE = "claude-opus-4"

#: Appears ONLY in real message text. The positive control: without it a
#: search that returned nothing at all would pass the zero above.
TEXT_NEEDLE = "pomegranate telemetry"

#: Appears nowhere. The absence control: a matcher that always finds
#: something is worse than useless.
ABSENT_NEEDLE = "zzz-no-such-phrase-anywhere-zzz"

#: The PRE-FIX matcher, reproduced here rather than imported, so this
#: file fails if the old behaviour ever returns instead of merely
#: checking that some keyword argument still exists.
_OLD_MATCHER_SQL = (
    "SELECT COUNT(*) FROM message_appearances a "
    "JOIN message_bodies b ON b.id = a.body_id "
    "WHERE a.transcript_id = ? "
    "  AND INSTR(LOWER(cloude_body_text(b.body_json)), LOWER(?)) > 0"
)


def _write_corpus(root: Path) -> None:
    """Write one session whose envelope carries the needle and whose text does not.

    Description: the assistant record names ``claude-opus-4`` twice in
      the envelope (``message.model`` and ``version``) and says nothing
      about it in its text, which is exactly the shape that produced
      33,805 false positives on the real corpus.
    Inputs: root (Path) - corpus root, created here.
    Output: None.
    Example: _write_corpus(tmp_path / "corpus")
    """
    slug_dir = root / SLUG
    slug_dir.mkdir(parents=True)
    (slug_dir / f"{SESSION_UUID}.jsonl").write_text(
        '{"type":"user","uuid":"u1","sessionId":"' + SESSION_UUID + '",'
        '"timestamp":"2026-08-29T00:00:00.000Z",'
        '"cwd":"/Users/x/falsepositive","version":"' + METADATA_NEEDLE + '",'
        '"message":{"role":"user","content":"check the '
        + TEXT_NEEDLE + ' report"}}\n'
        '{"type":"assistant","uuid":"a1","parentUuid":"u1",'
        '"sessionId":"' + SESSION_UUID + '",'
        '"timestamp":"2026-08-29T00:00:01.000Z",'
        '"cwd":"/Users/x/falsepositive","version":"' + METADATA_NEEDLE + '",'
        '"message":{"role":"assistant","model":"' + METADATA_NEEDLE + '",'
        '"content":[{"type":"text","text":"looked at the '
        + TEXT_NEEDLE + ' numbers"}]}}\n',
        encoding="utf-8",
    )


@pytest.fixture()
def searchable(tmp_path: Path):
    """Ingest, project, extract blocks and build the index, for real.

    Description: no fixture is supplied to the read path. Every row it
      searches was produced by the same code a real install runs.
    Inputs: tmp_path (Path).
    Output: (state_dir Path, transcript_id int, project_id int).
    Example: state, tid, pid = searchable
    """
    state = tmp_path / "state"
    ensure_db_migrated(state, 4, "0.8.2")
    conn = connect(db_path_for(state), create=False)
    try:
        apply_message_model_schema(conn)
        conn.commit()
    finally:
        conn.close()

    corpus = tmp_path / "corpus"
    _write_corpus(corpus)
    assert run_ingest_once(state, corpus_root=corpus).status == INGEST_OK
    assert run_projection_once(state).status == STATUS_OK

    conn = connect(db_path_for(state), create=False)
    try:
        with transaction(conn):
            report = build_pending(conn, state_dir=state)
        assert report.pending_after == 0, "the index must be fully built"
        tid = conn.execute(
            "SELECT id FROM message_transcripts ORDER BY id LIMIT 1"
        ).fetchone()[0]
        pid = conn.execute(
            "SELECT project_id FROM message_transcripts WHERE id = ?", (tid,)
        ).fetchone()[0]
    finally:
        conn.close()
    return state, int(tid), int(pid)


def _search(state: Path, q: str, tid: int) -> dict:
    """Run the real search over one transcript.

    Inputs: state (Path), q (str), tid (int).
    Output: dict - the envelope.
    """
    conn = connect(db_path_for(state), create=False)
    try:
        return archive_search.search_scoped(conn, q, "transcript", tid)
    finally:
        conn.close()


def test_a_metadata_needle_returns_no_hits(searchable) -> None:
    """The whole point: an envelope-only token is not a message hit."""
    state, tid, _ = searchable
    env = _search(state, METADATA_NEEDLE, tid)
    assert env["result_status"] == "ok", env["unevaluated"]
    assert env["result"] == [], (
        f"{METADATA_NEEDLE!r} appears only in the envelope of these records "
        f"and must not be reported as message text; got "
        f"{len(env['result'])} hits"
    )


def test_the_positive_control_still_finds_real_message_text(searchable) -> None:
    """Without this the zero above is satisfied by a search that is broken."""
    state, tid, _ = searchable
    env = _search(state, TEXT_NEEDLE, tid)
    assert env["result_status"] == "ok", env["unevaluated"]
    assert len(env["result"]) == 2, (
        f"{TEXT_NEEDLE!r} is in both records' message text; got "
        f"{len(env['result'])}"
    )
    kinds = {hit["block_type"] for hit in env["result"]}
    assert kinds == {"_string_content", "text"}, kinds
    assert all(hit["snippet"] and TEXT_NEEDLE in hit["snippet"]
               for hit in env["result"]), "the preview comes from the block"


def test_the_absence_control_finds_nothing(searchable) -> None:
    """A matcher that always finds something is worse than useless."""
    state, tid, _ = searchable
    env = _search(state, ABSENT_NEEDLE, tid)
    assert env["result_status"] == "ok"
    assert env["result"] == []


def test_the_old_matcher_would_have_returned_a_false_positive(
    searchable,
) -> None:
    """Reproduce the PRE-FIX rule inline, so this file can fail if it returns.

    Description: without this the other three tests prove only that the
      new search agrees with itself. This one proves the fixture actually
      HAS the defect, so the zero above is a fix rather than an accident
      of the corpus.
    """
    state, tid, _ = searchable
    conn = connect(db_path_for(state), create=False)
    try:
        old = int(conn.execute(
            _OLD_MATCHER_SQL, (tid, METADATA_NEEDLE)).fetchone()[0])
    finally:
        conn.close()
    assert old >= 2, (
        "the fixture must carry the defect for the zero above to mean "
        f"anything; the old substring matcher found {old} bodies"
    )


def test_a_filter_narrows_within_real_hits(searchable) -> None:
    """Role and block type narrow, and they narrow the same hits."""
    state, tid, _ = searchable
    env = _search(state, TEXT_NEEDLE, tid)
    assert len(env["result"]) == 2
    conn = connect(db_path_for(state), create=False)
    try:
        assistant = archive_search.search_scoped(
            conn, TEXT_NEEDLE, "transcript", tid, role="assistant")
        blocks = archive_search.search_scoped(
            conn, TEXT_NEEDLE, "transcript", tid, block_type="text")
        nobody = archive_search.search_scoped(
            conn, TEXT_NEEDLE, "transcript", tid, role="no-such-role")
    finally:
        conn.close()
    assert len(assistant["result"]) == 1
    assert assistant["result"][0]["role"] == "assistant"
    assert len(blocks["result"]) == 1
    assert blocks["result"][0]["block_type"] == "text"
    # A filter naming nothing is an empty ok, not a refusal: the caller
    # asked a well-formed question whose answer is none.
    assert nobody["result_status"] == "ok"
    assert nobody["result"] == []


def test_a_fresh_install_needs_no_rebuild_because_the_triggers_ran(
    searchable,
) -> None:
    """The AFTER INSERT trigger indexes as the projection writes.

    Description: this was NOT the expected result when the test was
      written - the first draft asserted that a projected-but-unbuilt
      install reports ``never_built``, and it failed because the index
      was already complete. The triggers are applied by the same schema
      step that creates the table, so a fresh install is indexed on the
      way in and ``rebuild_block_search_index.py`` is only ever needed by
      an install that already HAD content blocks when it crossed v29.
      That is a better outcome than the one expected and it is pinned
      here so a future change that moves indexing out of the triggers
      cannot pass quietly.
    """
    state, tid, _ = searchable
    conn = connect(db_path_for(state), create=False)
    try:
        indexed = int(conn.execute(
            "SELECT COUNT(*) FROM message_block_search").fetchone()[0])
        blocks = int(conn.execute(
            "SELECT COUNT(*) FROM message_content_blocks "
            "WHERE text IS NOT NULL AND text <> ''").fetchone()[0])
    finally:
        conn.close()
    assert blocks > 0, "the fixture must have produced content blocks"
    assert indexed == blocks, (
        f"the triggers must index every block as it is written; {indexed} "
        f"indexed against {blocks} blocks")


def test_an_emptied_index_refuses_rather_than_returning_zero(
    searchable,
) -> None:
    """never_built is a cannot_determine, and it does NOT fall back.

    Description: this is the rung that would otherwise re-create the
      defect. An install that already held content blocks when it crossed
      v29 arrives here, and so does a ``--rebuild`` run between its reset
      and its build. Answering "no results" there is the false green the
      whole design exists to stop, and falling back to the old scan would
      silently restore the false positives on exactly the installs least
      likely to notice.
    """
    state, tid, _ = searchable
    conn = connect(db_path_for(state), create=False)
    try:
        with transaction(conn):
            removed = reset_index(conn)
        assert removed > 0, "there must have been an index to empty"
        env = archive_search.search_scoped(conn, TEXT_NEEDLE, "transcript", tid)
    finally:
        conn.close()
    assert env["result_status"] == "cannot_determine", env["meta"]["index"]
    assert env["meta"]["index"]["state"] == "never_built"
    assert any(item["subject"] == "index" for item in env["unevaluated"])
    assert env["result"] is None, (
        "a refusal must not hand back an empty list, which renders "
        "identically to 'searched everything and found nothing'")
