"""THE TEST THAT WOULD HAVE CAUGHT IT: does the browser see an ingested corpus.

WHAT SHIPPED, AND WHY 4,874 GREEN TESTS DID NOT NOTICE. The background
ingester writes ``transcript_archives`` / ``transcript_records``. The
history browser reads ``message_transcripts`` / ``message_bodies`` /
``message_content_blocks`` / ``message_appearances``. Both halves had
thorough tests. Every one of them supplied its OWN fixture to the half it
was testing, so the ingester's tests proved the archive was written and
the browser's tests proved the rail rendered whatever was put in front of
it, and no test in the suite ever ran one half's output through the other
half's input. Measured on the owner's install: 22,828 archive rows,
3,703,771,340 compressed bytes, and zero rows in all four tables the
browser reads.

SO THIS FILE SUPPLIES NO FIXTURE TO THE READ PATH. It writes .jsonl
files, runs the REAL ingester over them, runs the REAL projection, and
then asks the REAL browse, read, turn and search functions what they can
see. Nothing is mocked and no function is asserted to have been called.
The only thing asserted is rows on the far side.

``test_the_browse_path_is_empty_before_the_projection_runs`` IS THE
NEGATIVE CONTROL AND IT IS THE POINT. It pins the defect's exact shape:
a corpus fully and correctly ingested, and a browser that sees nothing.
Without it, a projection that silently did nothing would still let the
positive tests pass on some other install's leftovers, and a projection
that ran at ingest time by accident would make the file prove nothing
about the join it claims to test.
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
from src.core import archive_hierarchy, archive_lines, archive_search, archive_turns
from src.core import message_projection_ledger as ledger
from src.core.corpus_ingest_service import STATUS_OK as INGEST_OK, run_ingest_once
from src.core.db import connect, db_path_for
from src.core.db_migration import ensure_db_migrated
from src.core.db_steps import apply_message_model_schema
from src.core.message_projection import STATUS_OK, run_projection_once
from src.core.message_projection_status import (
    STATUS_MEASURED,
    STATUS_NEVER_PROJECTED,
    projection_block,
)

SESSION_UUID = "22222222-2222-2222-2222-222222222222"
SLUG = "-Users-x-browsable"

#: A phrase that exists in the corpus exactly once, and one that exists
#: nowhere. A matcher that always finds something is worse than useless,
#: so both are asserted.
NEEDLE_PRESENT = "pomegranate telemetry"
NEEDLE_ABSENT = "zzz-no-such-phrase-in-this-corpus-zzz"


def _write_corpus(root: Path) -> Path:
    """Write a small but real corpus: one session and one subagent run.

    Description: the records carry the shapes the model reads - a user
      turn with a string content, an assistant turn with a content BLOCK
      list, and a subagent file whose records report the PARENT's
      sessionId, which is why identity has to come from the file stem.
    Inputs: root (Path) - corpus root, created here.
    Output: Path - the session transcript's path.
    Example: _write_corpus(tmp_path / "corpus")
    """
    slug_dir = root / SLUG
    sub_dir = slug_dir / SESSION_UUID / "subagents"
    sub_dir.mkdir(parents=True)
    session_file = slug_dir / f"{SESSION_UUID}.jsonl"
    session_file.write_text(
        '{"type":"user","uuid":"u1","sessionId":"' + SESSION_UUID + '",'
        '"timestamp":"2026-08-29T00:00:00.000Z",'
        '"message":{"role":"user","content":"check the '
        + NEEDLE_PRESENT + ' report"}}\n'
        '{"type":"assistant","uuid":"a1","parentUuid":"u1",'
        '"sessionId":"' + SESSION_UUID + '",'
        '"timestamp":"2026-08-29T00:00:01.000Z",'
        '"message":{"role":"assistant","model":"claude-test",'
        '"content":[{"type":"text","text":"looked at it"}]}}\n',
        encoding="utf-8",
    )
    (sub_dir / "agent-bbb.jsonl").write_text(
        '{"type":"user","uuid":"s1","sessionId":"' + SESSION_UUID + '",'
        '"timestamp":"2026-08-29T00:00:02.000Z",'
        '"message":{"role":"user","content":"subagent work"}}\n',
        encoding="utf-8",
    )
    return session_file


def _state_with_model(tmp_path: Path) -> Path:
    """Create a state dir whose datastore carries the message model.

    Description: the model is applied out of band on a real install
      (``src/main.py`` calls ``apply_message_model_schema`` when the
      archive flag is on), so a test that only migrated the numbered
      chain would be testing a datastore no user has.
    Inputs: tmp_path (Path).
    Output: Path - the state dir.
    Example: _state_with_model(tmp_path) / "cloude.db"
    """
    state = tmp_path / "state"
    ensure_db_migrated(state, 4, "0.8.2")
    conn = connect(db_path_for(state), create=False)
    try:
        apply_message_model_schema(conn)
        conn.commit()
    finally:
        conn.close()
    return state


def _ingested(tmp_path: Path):
    """Write a corpus and archive it, with no projection run.

    Inputs: tmp_path (Path).
    Output: (state_dir Path, corpus_root Path, session_file Path).
    Example: state, corpus, f = _ingested(tmp_path)
    """
    state = _state_with_model(tmp_path)
    corpus = tmp_path / "corpus"
    session_file = _write_corpus(corpus)
    report = run_ingest_once(state, corpus_root=corpus)
    assert report.status == INGEST_OK
    assert report.ingested == 2, "the archive half must have worked"
    return state, corpus, session_file


def _rail(state: Path):
    """Walk the browser's navigation rail, top to bottom.

    Description: exactly the four calls ``src/api/archive_routes.py``
      makes, in the order the client makes them, against a real
      connection. Returns the transcripts of the first project that has
      any, plus the counts each level reported.
    Inputs: state (Path) - state dir.
    Output: dict with 'hosts', 'corpora', 'projects', 'transcripts'.
    Example: _rail(state)["transcripts"]
    """
    conn = connect(db_path_for(state), create=False)
    try:
        hosts = archive_hierarchy.hosts(conn)["result"]
        if not hosts:
            return {"hosts": [], "corpora": [], "projects": [],
                    "transcripts": [], "conn": None}
        corpora = archive_hierarchy.corpora_for_host(
            conn, hosts[0]["host_id"])["result"]
        projects = []
        if corpora:
            projects = archive_hierarchy.projects_for_corpus(
                conn, corpora[0]["corpus_id"])["result"]
        transcripts = []
        for project in projects:
            found = archive_hierarchy.transcripts_for_project(
                conn, project["project_id"])["result"]
            transcripts.extend(found)
        return {"hosts": hosts, "corpora": corpora, "projects": projects,
                "transcripts": transcripts}
    finally:
        conn.close()


# --------------------------------------------------------------------------
# The negative control. This is the defect, pinned.
# --------------------------------------------------------------------------


def test_the_browse_path_is_empty_before_the_projection_runs(tmp_path):
    state, _corpus, _f = _ingested(tmp_path)

    conn = connect(db_path_for(state), create=False)
    try:
        archives = conn.execute(
            "SELECT COUNT(*) FROM transcript_archives").fetchone()[0]
        modelled = conn.execute(
            "SELECT COUNT(*) FROM message_transcripts").fetchone()[0]
    finally:
        conn.close()

    # Both halves of the shipped defect, in one place: the archive is
    # correct and complete, and the browser's own tables hold nothing.
    assert archives == 2
    assert modelled == 0
    assert _rail(state)["transcripts"] == []
    # And the status surface says why rather than reporting a zero that
    # reads like a drained queue.
    block = projection_block(state)
    assert block["status"] == STATUS_NEVER_PROJECTED
    assert "has ever completed" in block["reason"]


# --------------------------------------------------------------------------
# The positive case: the same corpus, after the join
# --------------------------------------------------------------------------


def test_the_browse_path_returns_the_ingested_corpus(tmp_path):
    state, _corpus, _f = _ingested(tmp_path)

    report = run_projection_once(state, respect_flag=False)

    assert report.status == STATUS_OK
    assert report.projected == 2
    assert report.could_not_read == 0
    assert report.could_not_ingest == 0
    assert report.pending_after == 0

    rail = _rail(state)
    assert len(rail["hosts"]) == 1
    assert len(rail["corpora"]) == 1
    assert [p["slug"] for p in rail["projects"]] == [SLUG]
    # Two transcripts, and the subagent run is filed under its own file
    # stem rather than under the parent's sessionId its records carry.
    refs = sorted(t["session_ref"] for t in rail["transcripts"])
    assert refs == [SESSION_UUID, "agent-bbb"]


def test_the_reader_and_the_chat_view_see_real_lines(tmp_path):
    state, _corpus, _f = _ingested(tmp_path)
    run_projection_once(state, respect_flag=False)
    transcript = next(
        t for t in _rail(state)["transcripts"]
        if t["session_ref"] == SESSION_UUID
    )

    conn = connect(db_path_for(state), create=False)
    try:
        lines = archive_lines.transcript_lines(
            conn, transcript["transcript_id"])["result"]
        turns = archive_turns.transcript_turns(
            conn, transcript["transcript_id"])["result"]
    finally:
        conn.close()

    assert [line["line_no"] for line in lines] == [0, 1]
    # Fidelity is the model's own measurement, not this test's opinion:
    # a projection that mangled the bytes would say so here.
    assert {line["fidelity_outcome"] for line in lines} == {"fidelity_verified"}
    assert [turn["role"] for turn in turns] == ["user", "assistant"]
    # The assistant turn's content BLOCK list was extracted, which is the
    # part of the model the archive layer cannot answer at all.
    assistant = turns[1]
    assert [block["type"] for block in assistant["blocks"]] == ["text"]
    assert assistant["blocks"][0]["text"] == "looked at it"


def test_search_finds_a_phrase_that_is_in_the_corpus_and_not_one_that_is_not(
    tmp_path,
):
    state, _corpus, _f = _ingested(tmp_path)
    run_projection_once(state, respect_flag=False)
    project_id = _rail(state)["projects"][0]["project_id"]

    conn = connect(db_path_for(state), create=False)
    try:
        hit = archive_search.search_scoped(
            conn, NEEDLE_PRESENT, "project", project_id)
        miss = archive_search.search_scoped(
            conn, NEEDLE_ABSENT, "project", project_id)
    finally:
        conn.close()

    assert hit["result_status"] == "ok"
    assert len(hit["result"]) == 1
    # THE NEGATIVE CONTROL FOR THE MATCHER. A search that returned
    # something for a phrase nobody wrote would pass the assertion above
    # perfectly and be worthless.
    assert miss["result_status"] == "ok"
    assert miss["result"] == []


# --------------------------------------------------------------------------
# Growth: the objection the v16 model could not answer on its own
# --------------------------------------------------------------------------


def test_a_grown_transcript_is_replaced_not_duplicated(tmp_path):
    state, corpus, session_file = _ingested(tmp_path)
    run_projection_once(state, respect_flag=False)
    before = _rail(state)["transcripts"]
    grown_id = next(
        t["transcript_id"] for t in before if t["session_ref"] == SESSION_UUID
    )

    with session_file.open("a", encoding="utf-8") as handle:
        handle.write(
            '{"type":"user","uuid":"u2","parentUuid":"a1",'
            '"sessionId":"' + SESSION_UUID + '",'
            '"timestamp":"2026-08-29T00:00:03.000Z",'
            '"message":{"role":"user","content":"one more turn"}}\n'
        )
    second_ingest = run_ingest_once(state, corpus_root=corpus)
    assert second_ingest.ingested == 1, "the archive must see the growth first"

    report = run_projection_once(state, respect_flag=False)

    assert report.status == STATUS_OK
    assert report.replaced == 1
    assert report.projected == 0
    after = _rail(state)["transcripts"]
    # ONE row for the file, not two. The whole point.
    assert len(after) == len(before)
    grown = next(t for t in after if t["session_ref"] == SESSION_UUID)
    assert grown["line_count"] == 3
    # The row is new (the replace is a delete plus an ingest, recorded,
    # never an in-place edit of a stored transcript's identity columns).
    assert grown["transcript_id"] != grown_id


def test_an_unchanged_corpus_projects_nothing_on_the_next_pass(tmp_path):
    state, _corpus, _f = _ingested(tmp_path)
    run_projection_once(state, respect_flag=False)

    second = run_projection_once(state, respect_flag=False)

    assert second.status == STATUS_OK
    assert second.projected == 0
    assert second.replaced == 0
    assert second.pending_before == 0
    assert second.budget_spent == "queue_empty"


# --------------------------------------------------------------------------
# The pass's own contract: budgets, refusals, liveness
# --------------------------------------------------------------------------


def test_the_budget_bounds_one_pass_and_the_backlog_is_reported(tmp_path):
    state, _corpus, _f = _ingested(tmp_path)

    first = run_projection_once(state, max_archives=1, respect_flag=False)

    assert first.projected == 1
    assert first.pending_before == 2
    assert first.pending_after == 1
    assert first.budget_spent == "archives"
    second = run_projection_once(state, max_archives=1, respect_flag=False)
    assert second.pending_after == 0


def test_every_terminating_path_publishes_a_named_status(tmp_path):
    from src.core import message_projection_state as pstate

    missing = tmp_path / "no-such-state-dir"
    report = run_projection_once(missing, respect_flag=False)

    assert report.status == "datastore_unavailable"
    assert report.reason
    # Published even on the failure path: a projection whose failures are
    # silent is indistinguishable from one with nothing left to do.
    record = pstate.read_liveness(missing)
    assert record is not None
    assert record["status"] == "datastore_unavailable"


def test_the_flag_being_off_is_a_refusal_that_says_so(tmp_path, monkeypatch):
    state, _corpus, _f = _ingested(tmp_path)
    monkeypatch.setenv("CLOUDE_MESSAGE_ARCHIVE", "0")

    report = run_projection_once(state)

    assert report.status == "disabled"
    assert report.projected == 0
    assert _rail(state)["transcripts"] == []


def test_the_status_block_reports_the_ledger_once_a_pass_has_run(tmp_path):
    state, _corpus, _f = _ingested(tmp_path)
    run_projection_once(state, respect_flag=False)

    block = projection_block(state)

    assert block["status"] == STATUS_MEASURED
    assert block["ledger"]["pending"] == 0
    assert block["ledger"][ledger.OUTCOME_PROJECTED] == 2
    assert block["freshness"] == "current"


def test_a_datastore_with_no_message_model_refuses_by_name(
    tmp_path, monkeypatch,
):
    # A datastore migrated with the archive flag OFF, which is the
    # default and therefore the common install: the chain's v16 step is
    # flag-gated, so no message table exists. The projection must refuse
    # by name rather than create a model the install never asked for.
    # respect_flag=False below is what makes this test the MODEL check
    # and not a second copy of the flag check above it.
    monkeypatch.setenv("CLOUDE_MESSAGE_ARCHIVE", "0")
    state = tmp_path / "state"
    ensure_db_migrated(state, 4, "0.8.2")
    monkeypatch.setenv("CLOUDE_MESSAGE_ARCHIVE", "1")
    corpus = tmp_path / "corpus"
    _write_corpus(corpus)
    run_ingest_once(state, corpus_root=corpus)

    report = run_projection_once(state, respect_flag=False)

    assert report.status == "model_absent"
    assert "never been applied" in (report.reason or "")


@pytest.mark.parametrize(
    "path,expected",
    [
        ("-Users-x/abc.jsonl", "abc"),
        ("-Users-x/22222222-2222-2222-2222-222222222222.jsonl",
         "22222222-2222-2222-2222-222222222222"),
        ("-Users-x/s/subagents/agent-bbb.jsonl", "agent-bbb"),
        ("-Users-x/audit", "audit"),
    ],
)
def test_the_session_ref_is_the_file_stem(path, expected):
    from src.core.message_projection import _session_ref_for

    assert _session_ref_for(path) == expected


@pytest.mark.asyncio
async def test_the_route_itself_serves_the_projected_corpus(tmp_path, monkeypatch):
    # ONE RUNG HIGHER THAN THE FUNCTIONS ABOVE: the actual route
    # coroutine, resolving the state directory the way a request does and
    # going out through run_read and the envelope-to-status mapping. It
    # is called directly rather than through TestClient because the point
    # here is the DATA reaching the envelope, not the auth dependency,
    # which tests/test_message_archive_routes_gating.py already owns.
    # Only the parameterless route is reachable this way - calling one
    # with a Query default passes the Query object itself - so this
    # proves the seam, and the four hierarchy functions above prove the
    # rest of the rail.
    from src.api import archive_routes
    from src.api.archive_routes import get_hosts

    state, _corpus, _f = _ingested(tmp_path)
    # The route module binds state_dir by name at import, so the patch
    # has to land in ITS namespace, not in archive_support's.
    monkeypatch.setattr(archive_routes, "state_dir", lambda: state)
    run_projection_once(state, respect_flag=False)

    response = await get_hosts()

    assert response.status_code == 200
    import json

    payload = json.loads(response.body)
    assert payload["result_status"] == "ok"
    assert len(payload["result"]) == 1
    assert payload["result"][0]["transcript_count"] == 2
