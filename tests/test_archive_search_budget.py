"""Tests for ``src/core/archive_search.py`` - outcomes, paging and literals.

THE POINT OF THIS FILE is still the pair of zero-hit answers, and the
PAIR CHANGED when the matcher moved onto the FTS5 index over content
blocks. It used to be "I searched the whole scope" against "I ran out of
budget"; one index query covers every transcript in scope, so a budget
can no longer bind and the second half is now "I could not search at
all" - a missing or never-built index, which REFUSES rather than
answering zero and deliberately does not fall back to the old scan.
Both halves are still the same empty ``result`` to a client that reads
only that field, and they still mean opposite things, so every assertion
here is on a DISCRIMINATING field.

The file keeps its name because it still tests this module's outcomes,
and one of those outcomes is that the budgets are now UNREACHABLE -
``test_the_byte_and_transcript_budgets_can_no_longer_bind`` pins that as
a regression guard, so a scan reintroduced here would be caught.

The other properties asserted:

  * a cursor reaches a hit the first page PROVABLY could not see, and
    resumes rather than restarting. Driven by the page LIMIT now, which
    is the live paging mechanism and always was.
  * ``%``, ``_`` and ``\\`` are literal. Each case includes a decoy row
    a wildcard implementation WOULD return. The matcher is now an FTS5
    phrase NARROWED by the same ``INSTR`` as before, so the literal
    contract is unchanged and these still discriminate.
  * a query with no alphanumeric character is a NAMED refusal, because
    the tokenizer produces no term from it. The substring scan could
    find such a string; that capability is gone and says so.
  * a secret-bearing hit is REPORTED with a withheld snippet, and the
    credential text appears nowhere in the serialized response.

THE FIXTURE BODIES ARE REAL RECORDS. They used to be a bare
``{"text": ...}`` object, which no real record looks like and which works
only if the matcher greps raw ``body_json``. See ``_record``.

Fixtures are temp databases built through the real migration, never the
live corpus.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from contextlib import closing
from pathlib import Path
from typing import Iterator, List, Tuple

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_as_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_as_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.archive_cursor import CURSOR_SEARCH, encode_cursor
from src.core.archive_read import open_read_only
from src.core.archive_search import (
    LINE_DONE,
    RESULT_CANNOT_DETERMINE,
    RESULT_NOT_FOUND,
    RESULT_OK,
    RESULT_PARTIAL,
    SCAN_BUDGET_EXHAUSTED,
    SCAN_COMPLETE,
    SCOPE_CANNOT_DETERMINE,
    SCOPE_NOT_FOUND,
    SNIPPET_WITHHELD_SECRET,
    search_scoped,
)
from src.core.db import connect as db_connect
from src.core.db_migration import ensure_db_migrated
from src.core.message_block_store import store_blocks_for_body

#: A fake credential. It is not a real secret and never was, but the test
#: treats it as one so the "never appears in the response" assertion is
#: meaningful.
FAKE_SECRET = "ZZZZfakecredentialnotrealZZZZ0123456789a"

#: Transcript sizes are what the byte budget spends, so they are declared
#: rather than derived: the resume test depends on knowing exactly which
#: transcript the first request can reach.
TRANSCRIPT_BYTES = 4096

#: One literal backslash, named so the escaping in this file's own source
#: cannot be mistaken for the escaping under test.
BACKSLASH = chr(92)


def _record(text: str) -> str:
    """Wrap one line of message text in a REAL assistant record.

    Description: these bodies used to be a bare ``{"text": ...}`` object,
      which is not a shape any real record has. That worked only while
      the matcher grepped the whole of ``body_json``. Search now matches
      the extracted content BLOCKS, and a body with no ``message`` key
      produces none - correctly - so the old fixture would make every
      assertion here a test of an empty index rather than of the matcher.
    Inputs: text (str) - the message text.
    Output: str - the body JSON.
    Example: _record("hi")
    """
    return json.dumps(
        {"type": "assistant",
         "message": {"role": "assistant",
                     "content": [{"type": "text", "text": text}]}})


def _insert(conn: sqlite3.Connection, project_id: int, transcripts) -> None:
    """Seed one project and its transcripts, newest first.

    Inputs: conn (writable), project_id (int), transcripts (sequence of
      ``(transcript_id, ingested_at, [(line_no, body_text, secrets), ...])``).
    Output: None.
    """
    conn.execute(
        "INSERT OR IGNORE INTO message_hosts (id, machine_id, "
        "machine_id_scheme, display_name, first_seen_at) VALUES "
        "(1, 'm1', 'declared', 'h', '2026-01-01T00:00:00.000000Z')"
    )
    conn.execute(
        "INSERT OR IGNORE INTO message_corpora (id, host_id, corpus_key, "
        "root_path, collected_at) VALUES "
        "(1, 1, 'c1', '/c', '2026-01-01T00:00:00.000000Z')"
    )
    conn.execute(
        "INSERT OR IGNORE INTO message_projects (id, corpus_id, slug, "
        "first_seen_at) VALUES (?, 1, ?, '2026-01-01T00:00:00.000000Z')",
        (project_id, f"proj-{project_id}"),
    )
    body_id = 1000 * project_id
    for tid, ingested_at, lines in transcripts:
        conn.execute(
            "INSERT INTO message_transcripts (id, source_ref, session_ref, "
            "session_ref_scheme, line_ending, has_trailing_newline, "
            "line_count, content_sha256, raw_byte_length, ingested_at, "
            "host_id, corpus_id, project_id, source_path) VALUES "
            "(?, ?, ?, 'uuid', 'LF', 1, ?, 'sha', ?, ?, 1, 1, ?, ?)",
            (tid, f"ref-{tid}", f"sess-{tid}", len(lines), TRANSCRIPT_BYTES,
             ingested_at, project_id, f"p{project_id}/{tid}.jsonl"),
        )
        for line_no, text, secrets in lines:
            body_id += 1
            record = _record(text)
            conn.execute(
                "INSERT INTO message_bodies (id, identity_key, message_uuid, "
                "body_sha256, body_bytes_sha256, body_json, "
                "secret_finding_count, first_seen_at) VALUES "
                "(?, ?, ?, 'a', 'b', ?, ?, '2026-01-01T00:00:00.000000Z')",
                (body_id, f"k{body_id}", f"u{body_id}", record, secrets),
            )
            # The REAL extractor, so the blocks these tests search are the
            # blocks a real install holds and the FTS triggers fire.
            store_blocks_for_body(conn, body_id, record,
                                  "2026-01-01T00:00:00.000000Z")
            conn.execute(
                "INSERT INTO message_appearances (id, transcript_id, line_no, "
                "line_status, body_id, line_sha256, line_byte_length, "
                "fidelity_outcome) VALUES (?, ?, ?, 'ok', ?, 's', ?, "
                "'fidelity_verified')",
                (body_id, tid, line_no, body_id, len(record)),
            )
    conn.commit()


@pytest.fixture()
def corpus(tmp_path) -> Iterator[sqlite3.Connection]:
    """A temp archive: project 1 (three transcripts) and empty project 2.

    Transcript 30 is NEWEST and holds no target term. Transcript 20 holds
    the resume target, and transcript 10 is oldest. Scan order is
    ingested_at DESC, so a one-transcript budget reaches 30 and nothing
    else - which is what makes the resume assertion real rather than
    decorative.
    """
    state = tmp_path / "state"
    ensure_db_migrated(state, 4, "0.8.2")
    with closing(db_connect(state / "cloude.db")) as write_conn:
        _insert(write_conn, 1, [
            (30, "2026-08-30T00:00:00.000000Z", [
                (0, "nothing of interest here", 0),
                (1, "1000 items and a decoy", 0),
                (2, "axb decoy for underscore", 0),
            ]),
            (20, "2026-08-20T00:00:00.000000Z", [
                (0, "the restic beacon lives here", 0),
                (1, "discount 100% off today", 0),
                (2, "literal a_b token", 0),
                (3, "path C:" + BACKSLASH + "pdata written", 0),
                (4, "restic near " + FAKE_SECRET + " end", 2),
            ]),
            (10, "2026-08-10T00:00:00.000000Z", [
                (0, "oldest transcript, quiet", 0),
            ]),
        ])
        # Project 2 exists and holds nothing. An empty scope is an ``ok``
        # measurement, not a not_found.
        write_conn.execute(
            "INSERT INTO message_projects (id, corpus_id, slug, first_seen_at)"
            " VALUES (2, 1, 'proj-2', '2026-01-01T00:00:00.000000Z')"
        )
        write_conn.commit()
    with closing(open_read_only(state)) as conn:
        yield conn


def _hit_lines(payload) -> List[Tuple[int, int]]:
    """(transcript_id, line_no) for every hit, for identity assertions."""
    return [(h["transcript_id"], h["line_no"]) for h in payload["result"]]


# --- the two zero-hit answers ----------------------------------------------



def test_zero_hits_searched_and_zero_hits_unsearchable_differ(corpus,
                                                              tmp_path):
    """The whole reason this file exists, re-pointed at what replaced it.

    Description: "I searched the whole scope and found nothing" and "I
    could not search at all" are the same empty ``result`` to a client
    that reads only that field, and they mean opposite things. THE PAIR
    CHANGED with the matcher. It used to be complete-versus-budget
    exhausted; the index covers every transcript in scope in one query,
    so a budget can no longer bind (see the test below, which pins that)
    and the second half of the pair is now a REFUSAL: an index that is
    missing or has never been built answers cannot_determine and does NOT
    fall back to the old scan, which would silently restore the
    false-positive defect the index exists to remove.

    Every assertion is on a field that DIFFERS, never on the emptiness of
    the list.
    """
    from src.core.db import connect as _connect
    from src.core.message_block_search_index import reset_index

    searched = search_scoped(corpus, "zzzznotpresent", "project", 1)

    # A second, identical archive whose index has been emptied. Same
    # rows, same query, and the only difference is whether the index can
    # answer - which is what makes this a controlled comparison rather
    # than two unrelated payloads.
    state = tmp_path / "unindexed"
    ensure_db_migrated(state, 4, "0.8.2")
    with closing(db_connect(state / "cloude.db")) as write_conn:
        _insert(write_conn, 1, [
            (30, "2026-08-30T00:00:00.000000Z", [(0, "quiet", 0)]),
        ])
        with write_conn:
            reset_index(write_conn)
    with closing(open_read_only(state)) as unindexed_conn:
        refused = search_scoped(unindexed_conn, "zzzznotpresent", "project", 1)

    assert searched["result"] == [] and refused["result"] is None

    assert searched["result_status"] == RESULT_OK
    assert refused["result_status"] == RESULT_CANNOT_DETERMINE

    assert searched["meta"]["index"]["state"] == "present"
    assert refused["meta"]["index"]["state"] == "never_built"

    assert searched["meta"]["scan"]["status"] == SCAN_COMPLETE
    assert refused["meta"]["scan"]["status"] == "not_run"

    assert searched["meta"]["scan"]["transcripts_scanned"] == 3
    assert refused["meta"]["scan"]["transcripts_scanned"] is None

    assert any(item["subject"] == "index" for item in refused["unevaluated"])
    assert not any(item["subject"] == "index"
                   for item in searched["unevaluated"])

    # has_more is False only when a list was actually read to its end.
    assert searched["meta"]["paging"]["has_more"] is False
    assert refused["meta"]["paging"]["has_more"] is None


def test_the_byte_and_transcript_budgets_can_no_longer_bind(corpus):
    """budget_exhausted is UNREACHABLE on the index path, and that is pinned.

    Description: the vocabulary word stays - a caller's branch on it is
      still correct - but one index query covers the whole scope, so
      nothing can stop short. This is a REGRESSION GUARD rather than a
      description: if a future change puts a scan back on this path, the
      smallest possible budgets will start producing partial answers
      again and this fails.

      ``bytes_scanned`` is 0 because no body_json was read, and
      ``scan.method`` says ``fts_index`` so a reader knows why a real
      number is zero rather than assuming a broken counter.
    """
    out = search_scoped(
        corpus, "restic", "project", 1, scan_budget=1, scan_bytes=1)
    assert out["result_status"] == RESULT_OK
    assert out["meta"]["scan"]["status"] == SCAN_COMPLETE
    assert out["meta"]["scan"]["status"] != SCAN_BUDGET_EXHAUSTED
    assert out["result_status"] != RESULT_PARTIAL
    assert out["meta"]["scan"]["resume_cursor"] is None
    assert out["meta"]["scan"]["method"] == "fts_index"
    assert out["meta"]["scan"]["bytes_scanned"] == 0
    # The budgets are still ACCEPTED and still REPORTED, because removing
    # a parameter is a shape change. They simply never bind.
    assert out["meta"]["scan"]["budget_transcripts"] == 1
    assert out["meta"]["scan"]["budget_bytes"] == 1
    # And the hits are all there, which is what makes the above a
    # statement about budgets rather than about a broken search.
    assert len(out["result"]) == 2


def test_scanned_plus_not_scanned_always_equals_the_scope(corpus):
    """A checkable arithmetic invariant, not a vibe."""
    for budget in (1, 2, 3):
        scan = search_scoped(
            corpus, "restic", "project", 1, scan_budget=budget
        )["meta"]["scan"]
        assert (
            scan["transcripts_scanned"] + scan["transcripts_not_scanned"] == 3
        )


def test_empty_project_is_ok_not_not_found(corpus):
    """A real but empty scope is a measurement: ok, complete, nothing."""
    out = search_scoped(corpus, "restic", "project", 2)
    assert out["result_status"] == RESULT_OK
    assert out["scope_status"] == "resolved"
    assert out["meta"]["scan"]["status"] == SCAN_COMPLETE
    assert out["meta"]["scope"]["transcripts_in_scope"] == 0


# --- resume ----------------------------------------------------------------



def test_paging_reaches_a_hit_the_first_page_could_not(corpus):
    """Resume by PAGE, which is the mechanism that survived.

    Description: this test used to drive the resume cursor with a
      one-transcript BUDGET. Budgets no longer bind, so the same property
      - a cursor reaches a hit the first request provably could not see,
      and resumes rather than restarting - is asserted through the page
      limit, which is the live paging mechanism and always was.
    """
    first = search_scoped(corpus, "restic", "project", 1, limit=1)
    assert len(first["result"]) == 1
    assert first["meta"]["paging"]["has_more"] is True
    seen = _hit_lines(first)

    cursor = first["meta"]["paging"]["next_cursor"]
    assert cursor
    second = search_scoped(
        corpus, "restic", "project", 1, limit=1, cursor=cursor)
    assert second["result_status"] == RESULT_OK
    # It resumed, it did not restart.
    assert _hit_lines(second) != seen
    assert set(_hit_lines(second)).isdisjoint(seen)
    assert second["meta"]["paging"]["has_more"] is False
    assert second["meta"]["paging"]["next_cursor"] is None


def test_paging_a_full_scan_visits_every_hit_exactly_once(corpus):
    """limit=1 walks the same hits as one unlimited request, in order."""
    whole = _hit_lines(search_scoped(corpus, "restic", "project", 1))
    walked: List[Tuple[int, int]] = []
    cursor = None
    for _ in range(10):
        page = search_scoped(corpus, "restic", "project", 1, limit=1,
                             cursor=cursor)
        walked.extend(_hit_lines(page))
        cursor = page["meta"]["paging"]["next_cursor"]
        if cursor is None:
            break
    assert walked == whole
    assert len(walked) == len(set(walked))


# --- literal matching ------------------------------------------------------


@pytest.mark.parametrize(
    "query, expect_line, decoy_line",
    [
        # A naive LIKE '%100%%' matches "1000 items" too.
        ("100%", 1, 1),
        # A naive LIKE '%a_b%' matches "axb" too.
        ("a_b", 2, 2),
        # A backslash is the LIKE escape character in many dialects.
        (f"C:{BACKSLASH}p", 3, None),
    ],
)
def test_like_metacharacters_match_literally(corpus, query, expect_line,
                                             decoy_line):
    """Each case carries a decoy a wildcard implementation would return."""
    out = search_scoped(corpus, query, "project", 1)
    assert out["result_status"] == RESULT_OK
    hits = _hit_lines(out)
    assert (20, expect_line) in hits, f"{query!r} did not match its own row"
    if decoy_line is not None:
        assert (30, decoy_line) not in hits, (
            f"{query!r} matched the decoy row: the metacharacter was treated "
            "as a wildcard"
        )
    assert len(hits) == 1



def test_a_query_with_no_token_is_refused_not_answered_with_zero(corpus):
    """``%%`` was a wildcard hazard; it is now an unanswerable query.

    Description: the performance half of the metacharacter defect is gone
      by construction - there is no LIKE any more - but a string with no
      alphanumeric character produces no token, so the index genuinely
      cannot be asked about it. The substring scan COULD find such a
      string, so this is a real loss of capability and it is a NAMED
      refusal rather than a result of zero hits.
    """
    out = search_scoped(corpus, "%%", "project", 1)
    assert out["result_status"] == RESULT_CANNOT_DETERMINE
    assert out["result"] is None
    assert out["unevaluated"][0]["subject"] == "q"
    assert "no alphanumeric character" in out["unevaluated"][0]["reason"]


# --- secrets ---------------------------------------------------------------


def test_secret_bearing_hit_is_reported_with_the_snippet_withheld(corpus):
    """Withholding the snippet must never withhold the hit."""
    out = search_scoped(corpus, "restic", "project", 1)
    secret_hits = [h for h in out["result"] if h["secret_finding_count"] > 0]
    assert len(secret_hits) == 1, "the secret-bearing hit was dropped"

    hit = secret_hits[0]
    assert hit["snippet"] is None
    assert hit["snippet_state"] == SNIPPET_WITHHELD_SECRET
    # The finding itself is intact: an operator can still locate it.
    assert hit["transcript_id"] == 20
    assert hit["line_no"] == 4
    # The offset indexes the content BLOCK's text now, not body_json,
    # and the hit says so. "restic near ..." starts with the match.
    assert hit["match_offset_in"] == "block_text"
    assert hit["match_offset"] == 0
    assert hit["match_length"] == len("restic")
    assert hit["body_href"].endswith(str(hit["body_id"]))

    # The credential appears NOWHERE in the serialized response.
    assert FAKE_SECRET not in json.dumps(out)


def test_a_non_secret_hit_still_gets_its_snippet(corpus):
    """Positive control: a withheld snippet must mean something.

    A test that only asserts the withheld case cannot tell correct
    withholding from a snippet builder that is simply broken.
    """
    out = search_scoped(corpus, "beacon", "project", 1)
    assert len(out["result"]) == 1
    hit = out["result"][0]
    assert hit["snippet_state"] == "included"
    assert "beacon" in hit["snippet"]


# --- scope is mandatory ----------------------------------------------------


@pytest.mark.parametrize("scope", ["", "global", "corpus", "all", None])
def test_an_unscoped_or_unknown_scope_is_cannot_determine(corpus, scope):
    """Never silently run globally: that is a 17.6 second full scan."""
    out = search_scoped(corpus, "restic", scope, 1)
    assert out["result_status"] == RESULT_CANNOT_DETERMINE
    assert out["scope_status"] == SCOPE_CANNOT_DETERMINE
    assert out["result"] is None
    assert out["unevaluated"][0]["subject"] == "scope"
    # Nothing was measured, so no count may be reported.
    assert out["meta"]["scan"]["status"] == "not_run"
    assert out["meta"]["scan"]["transcripts_scanned"] is None
    assert out["meta"]["paging"]["has_more"] is None


def test_an_unknown_scope_id_is_not_found_not_an_empty_ok(corpus):
    """There is no project 99999 to have results."""
    out = search_scoped(corpus, "restic", "project", 99999)
    assert out["result_status"] == RESULT_NOT_FOUND
    assert out["scope_status"] == SCOPE_NOT_FOUND
    assert out["result"] == []
    assert out["meta"]["paging"]["has_more"] is None


def test_transcript_scope_searches_only_that_transcript(corpus):
    """The other legal scope, and it must not leak into its neighbours."""
    out = search_scoped(corpus, "restic", "transcript", 20)
    assert out["result_status"] == RESULT_OK
    assert {tid for tid, _ in _hit_lines(out)} == {20}
    assert out["meta"]["scope"]["transcript_id"] == 20


# --- cursors ---------------------------------------------------------------


@pytest.mark.parametrize(
    "bad",
    [
        "!!!not-base64!!!",
        "e30",                                    # valid base64, empty payload
        encode_cursor("lines", {"v": 1, "line_no": 3}),   # wrong kind
    ],
)
def test_a_malformed_cursor_is_cannot_determine_never_a_restart(corpus, bad):
    """A silent restart renders duplicates forever and never finishes."""
    out = search_scoped(corpus, "restic", "project", 1, cursor=bad)
    assert out["result_status"] == RESULT_CANNOT_DETERMINE
    assert out["result"] is None
    assert out["unevaluated"][0]["subject"] == "cursor"
    assert out["meta"]["scan"]["status"] == "not_run"
    # The scope resolved fine; it is the cursor that did not.
    assert out["scope_status"] == "resolved"


def test_a_cursor_from_another_transcript_is_refused(corpus):
    """Replaying a position against a different scope means nothing."""
    alien = encode_cursor(CURSOR_SEARCH, {
        "v": 1, "t_ingested_at": "2026-08-30T00:00:00.000000Z", "t_id": 30,
        "line_no": LINE_DONE, "scanned": 1, "bytes": TRANSCRIPT_BYTES,
    })
    out = search_scoped(corpus, "restic", "transcript", 20, cursor=alien)
    assert out["result_status"] == RESULT_CANNOT_DETERMINE
    assert out["unevaluated"][0]["subject"] == "cursor"


def test_bad_bounds_are_refused_rather_than_clamped(corpus):
    """A clamped limit produces a short page that reads as the end."""
    for kwargs, subject in (
        ({"limit": 0}, "limit"),
        ({"limit": 10_000}, "limit"),
        ({"scan_budget": 0}, "scan_budget"),
        ({"scan_bytes": 0}, "scan_bytes"),
    ):
        out = search_scoped(corpus, "restic", "project", 1, **kwargs)
        assert out["result_status"] == RESULT_CANNOT_DETERMINE
        assert out["unevaluated"][0]["subject"] == subject

    short = search_scoped(corpus, "r", "project", 1)
    assert short["unevaluated"][0]["subject"] == "q"


def test_the_whole_scope_is_reported_as_scanned(corpus):
    """One index query covers the scope, so scanned == in_scope.

    Description: this test used to assert that a byte budget below one
      transcript still made progress - charging the budget BEFORE the
      scan would have minted a resume cursor that never advanced, a loop
      that looks exactly like paging. There is no per-transcript scan
      left to charge, so the property it protected is now trivially true
      and the measurement that replaced it is the invariant: every
      transcript in scope WAS searched, by the index, in one query.

      ``bytes_scanned`` is 0 and that is a measurement: no ``body_json``
      was read at all.
    """
    out = search_scoped(corpus, "restic", "project", 1, scan_bytes=1)
    scan = out["meta"]["scan"]
    assert scan["transcripts_scanned"] == 3
    assert scan["transcripts_scanned"] == out["meta"]["scope"][
        "transcripts_in_scope"]
    assert scan["transcripts_not_scanned"] == 0
    assert scan["bytes_scanned"] == 0
    assert scan["method"] == "fts_index"
    assert scan["resume_cursor"] is None
