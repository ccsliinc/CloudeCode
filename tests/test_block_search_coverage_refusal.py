"""The 37 percent that is correctly unsearchable must be a NAMED outcome.

THE FACT. Measured on the 400-transcript projection, 2026-09-13, over
216,716 bodies: 129,796 are ``blocks_extracted`` and 7,253
``content_string`` (both indexed), and 79,667 - 36.8 percent - are
``no_message_content``. Those are attachments, file-history snapshots and
titles. They carry no message text, so the index legitimately cannot find
anything in them, and what the old substring scan DID find in them was
purely envelope metadata: the false positives this whole change exists to
remove.

THE RISK THAT CREATES. A user who searches for something that only
appears in an attachment now gets an empty list, and an empty list is
indistinguishable from "searched everything, found nothing". That is the
same shape as a green dot over a dead session.

SO THE TEST IS ABOUT THE REFUSAL, NOT THE HIT. An empty page over a scope
holding unindexed bodies must carry a named ``unevaluated`` entry - the
field the three-outcome contract already says a caller must branch on -
and the counts behind it, broken down by WHY each body is outside the
index. "not found", "not indexed" and "never looked at" are three
different answers.

THE NEGATIVE CONTROL: a scope where everything IS indexed must NOT raise
the coverage refusal, or the entry becomes noise that means nothing and
a reader learns to ignore it.
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
from src.core.db import connect, db_path_for
from src.core.db_migration import ensure_db_migrated
from src.core.db_steps import apply_message_model_schema
from src.core.message_block_search_status import (
    COVERAGE_INDEXED,
    COVERAGE_NEVER_PROCESSED,
    COVERAGE_NO_MESSAGE_CONTENT,
    resolve_coverage,
)
from src.core.message_projection import STATUS_OK, run_projection_once

SLUG_MIXED = "-Users-x-mixed"
SLUG_CLEAN = "-Users-x-clean"
UUID_MIXED = "66666666-6666-6666-6666-666666666666"
UUID_CLEAN = "77777777-7777-7777-7777-777777777777"

ABSENT = "zzz-nothing-matches-this-zzz"


def _mixed_records() -> str:
    """One searchable turn and one record with no message content.

    Description: the second record is an ``attachment``, which is one of
      the real shapes behind the 79,667. It has no ``message`` key at
      all, so the block extractor records ``no_message_content`` and
      nothing about it is searchable - while its envelope is full of
      text the old matcher would have hit on.
    Inputs: none. Output: str.
    """
    return (
        '{"type":"user","uuid":"m1","sessionId":"' + UUID_MIXED + '",'
        '"timestamp":"2026-08-29T00:00:00.000Z","cwd":"/Users/x/mixed",'
        '"message":{"role":"user","content":"findable message text"}}\n'
        '{"type":"attachment","uuid":"m2","sessionId":"' + UUID_MIXED + '",'
        '"timestamp":"2026-08-29T00:00:01.000Z","cwd":"/Users/x/mixed",'
        '"attachment":{"path":"/Users/x/mixed/secret-plan.txt",'
        '"content":"only in the attachment"}}\n'
    )


def _clean_records() -> str:
    """Two turns, both carrying real message text and nothing else.

    Inputs: none. Output: str.
    """
    return (
        '{"type":"user","uuid":"c1","sessionId":"' + UUID_CLEAN + '",'
        '"timestamp":"2026-08-29T00:00:00.000Z","cwd":"/Users/x/clean",'
        '"message":{"role":"user","content":"all of this is searchable"}}\n'
        '{"type":"assistant","uuid":"c2","parentUuid":"c1",'
        '"sessionId":"' + UUID_CLEAN + '",'
        '"timestamp":"2026-08-29T00:00:01.000Z","cwd":"/Users/x/clean",'
        '"message":{"role":"assistant","model":"claude-test","content":'
        '[{"type":"text","text":"and so is this"}]}}\n'
    )


@pytest.fixture()
def two_projects(tmp_path: Path):
    """Two transcripts: one with an unsearchable body, one without.

    Inputs: tmp_path (Path).
    Output: (state_dir Path, mixed transcript id, clean transcript id).
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
    (corpus / SLUG_MIXED).mkdir(parents=True)
    (corpus / SLUG_CLEAN).mkdir(parents=True)
    (corpus / SLUG_MIXED / f"{UUID_MIXED}.jsonl").write_text(
        _mixed_records(), encoding="utf-8")
    (corpus / SLUG_CLEAN / f"{UUID_CLEAN}.jsonl").write_text(
        _clean_records(), encoding="utf-8")
    assert run_ingest_once(state, corpus_root=corpus).status == INGEST_OK
    assert run_projection_once(state).status == STATUS_OK
    conn = connect(db_path_for(state), create=False)
    try:
        ids = {row[1]: int(row[0]) for row in conn.execute(
            "SELECT id, session_ref FROM message_transcripts")}
    finally:
        conn.close()
    return state, ids[UUID_MIXED], ids[UUID_CLEAN]


def _search(state: Path, q: str, tid: int) -> dict:
    """Run the real search over one transcript.

    Inputs: state (Path), q (str), tid (int). Output: dict.
    """
    conn = connect(db_path_for(state), create=False)
    try:
        return archive_search.search_scoped(conn, q, "transcript", tid)
    finally:
        conn.close()


def test_the_coverage_ladder_names_why_a_body_is_unsearchable(two_projects):
    """resolve_coverage separates indexed from no_message_content."""
    state, mixed, _ = two_projects
    conn = connect(db_path_for(state), create=False)
    try:
        coverage = resolve_coverage(conn, "transcript", mixed)
    finally:
        conn.close()
    assert coverage.complete
    assert coverage.by_reason.get(COVERAGE_INDEXED, 0) >= 1
    assert coverage.by_reason.get(COVERAGE_NO_MESSAGE_CONTENT, 0) >= 1, (
        f"the attachment must be counted as no_message_content; got "
        f"{coverage.by_reason}")
    assert COVERAGE_NEVER_PROCESSED not in coverage.by_reason, (
        "every body here was processed; never_processed is the "
        "we-have-not-looked state and must not be claimed")


def test_an_empty_page_over_unindexed_bodies_names_the_gap(two_projects):
    """The refusal, on the scope that actually has unsearchable content."""
    state, mixed, _ = two_projects
    env = _search(state, ABSENT, mixed)
    assert env["result_status"] == "ok"
    assert env["result"] == []
    subjects = {item["subject"] for item in env["unevaluated"]}
    assert f"transcript:{mixed}" in subjects, (
        f"an empty page over a scope holding unindexed bodies must name "
        f"the gap; unevaluated was {env['unevaluated']}")
    reason = next(item["reason"] for item in env["unevaluated"]
                  if item["subject"] == f"transcript:{mixed}")
    assert COVERAGE_NO_MESSAGE_CONTENT in reason
    assert "NOT FOUND IN INDEXED TEXT" in reason
    meta = env["meta"]["coverage"]
    assert meta["measured"] is True
    assert meta["bodies_not_indexed"] >= 1


def test_a_fully_indexed_scope_raises_no_coverage_refusal(two_projects):
    """THE NEGATIVE CONTROL: the entry must mean something when it appears.

    Description: if every empty search carried this entry it would be
      noise, and a reader would learn to ignore the one case where it
      matters. So a scope where everything IS indexed must not raise it.
    """
    state, _, clean = two_projects
    env = _search(state, ABSENT, clean)
    assert env["result_status"] == "ok"
    assert env["result"] == []
    subjects = {item["subject"] for item in env["unevaluated"]}
    assert f"transcript:{clean}" not in subjects, (
        f"nothing in this scope is unindexed, so there is no gap to name; "
        f"unevaluated was {env['unevaluated']}")
    assert env["meta"]["coverage"]["bodies_not_indexed"] == 0


def test_an_empty_page_always_names_the_tokenizer_limit(two_projects):
    """The other half of an empty answer: the matcher's own gap.

    Description: ``unicode61`` matches whole tokens and prefixes, so a
      query beginning inside a word cannot be found - measured recall
      against a full substring scan is 96.7 to 100 percent over twelve
      real queries. A user who typed a word fragment and got nothing is
      entitled to know that before concluding the corpus does not hold
      it.
    """
    state, _, clean = two_projects
    env = _search(state, ABSENT, clean)
    reason = next((item["reason"] for item in env["unevaluated"]
                   if item["subject"] == "q"), None)
    assert reason is not None, env["unevaluated"]
    assert "INSIDE a word" in reason
    assert "sendResize" in reason


def test_a_page_with_hits_does_not_carry_either_refusal(two_projects):
    """Both entries are for an EMPTY page, and only for an empty page."""
    state, mixed, _ = two_projects
    env = _search(state, "findable", mixed)
    assert env["result"], "the positive control must find something"
    assert env["unevaluated"] == [], (
        f"a page with hits cannot be mistaken for 'nothing here', so it "
        f"carries no refusal; got {env['unevaluated']}")
    assert env["meta"]["coverage"]["measured"] is False, (
        "coverage costs a pass over the scope's bodies and is measured "
        "only where it is load-bearing; 'not measured' is the truth and "
        "is not the same as claiming everything was indexed")
