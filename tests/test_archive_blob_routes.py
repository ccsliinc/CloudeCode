"""The byte-exact archive's HTTP surface: content, chains, id space, refusals.

WHAT THE ORIGINAL GAP WAS, AND WHICH TEST HERE WOULD HAVE CAUGHT IT.
``transcript_archives`` held 23,475 byte-exact rows and had NO HTTP
surface, while every ``/archive`` route read ``message_transcripts``,
which held 0. Nothing failed, because nothing asserted an END-TO-END
RESULT - the endpoint existed, answered, and answered about nothing.
:class:`TestExportReturnsRealContent` is the test that closes it: it
ingests known bytes and asserts the route hands those exact bytes back.
An assertion that the route merely returns 200 would still pass against
the broken shape.

THE CHAIN CASE IS MANDATORY AND IS BUILT BY THE REAL DEDUPE MODULE.
A fixture that only ever creates head-of-chain rows passes against the
WRONG understanding of this table, because a head row's own
``content_gzip`` is its content and a naive read looks correct. That is
exactly why the corpus round-trip harness's "400 of 400" was narrower
than it looked: it never imports ``transcript_prefix_dedupe``, so every
row it made had ``superseded_by_archive_id`` NULL by construction and it
could not build the shape it was believed to be testing.
:class:`TestSupersessionChain` calls ``ingest_with_prefix_dedupe`` for
real, asserts the middle rows genuinely hold the 8-byte sentinel, and
only then asserts they still export their own full original bytes.

NEGATIVE CONTROLS ARE THE POINT, NOT DECORATION. A verifier that always
passes is worse than none. Each refusal test damages exactly one thing
and asserts the SPECIFIC refusal, and the hash and length halves are
broken SEPARATELY - a length-only check misses a flipped bit and a
hash-only check passes an empty reconstruction against an empty row.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import sys
import tempfile
import zlib
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

import pytest

# The app's settings module exits the process when these are absent, so
# the bootstrap has to run BEFORE any src import. Matches the preamble in
# tests/test_projects_archive_route.py.
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_blob_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_blob_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# ruff: noqa: E402
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.archive_routes import router as archive_router
from src.api.auth import require_auth
from src.config import settings
from src.core.archive_blob_export import (
    ARCHIVE_EXPORT_CHAIN_BROKEN,
    ARCHIVE_EXPORT_INTEGRITY_MISMATCH,
    ARCHIVE_EXPORT_NOT_FOUND,
    ARCHIVE_EXPORT_OK,
    ARCHIVE_EXPORT_RECONSTRUCTION_FAILED,
    ARCHIVE_EXPORT_TOO_LARGE,
    REF_ARCHIVE_UUID,
    REF_INTEGER_ID,
    REF_MALFORMED,
    archive_head,
    archive_uuid_for_rowid,
    classify_archive_ref,
    verified_archive_export,
)
from src.core.db import connect, db_path_for
from src.core.db_migration import ensure_db_migrated
from src.core.transcript_archive import export_archive, ingest_transcript_bytes
from src.core.transcript_prefix_dedupe import ingest_with_prefix_dedupe

API = "/api/v1/archive"

#: The 8-byte blob a superseded row's content is replaced with. Named
#: here so a test asserts against the real sentinel rather than "small".
SENTINEL = zlib.compress(b"", 9)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """Point the app at a throwaway state directory with a migrated database.

    Inputs: tmp_path (Path), monkeypatch.
    Output: SimpleNamespace with state_dir.
    """
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    monkeypatch.setattr(
        type(settings), "get_state_dir", lambda self: state_dir, raising=True
    )
    assert ensure_db_migrated(state_dir, 4, "0.0.0").status == "ok"
    return SimpleNamespace(state_dir=state_dir)


def open_db(env) -> sqlite3.Connection:
    """Open the throwaway database with the archive attached, as the app does.

    Inputs: env - the fixture.
    Output: sqlite3.Connection.
    """
    return connect(db_path_for(env.state_dir))


def client() -> TestClient:
    """Build a TestClient over the real archive router with auth stubbed.

    Inputs: none.
    Output: TestClient.
    """
    app = FastAPI()
    app.include_router(archive_router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: {"sub": "test"}
    return TestClient(app)


def store(conn: sqlite3.Connection, data: bytes, name: str = "a.jsonl") -> int:
    """Ingest raw bytes as one archive row and return its id.

    Inputs: conn, data (bytes), name (str) - the recorded source path.
    Output: int - the transcript_archives.id.
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        archive_id = ingest_transcript_bytes(
            conn, data, kind="session", source_path=name
        )
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
    return archive_id


def uuid_of(conn: sqlite3.Connection, archive_id: int) -> str:
    """Return one archive row's archive_uuid.

    Inputs: conn, archive_id (int). Output: str.
    """
    return conn.execute(
        "SELECT archive_uuid FROM transcript_archives WHERE id = ?",
        (archive_id,),
    ).fetchone()[0]


# ---------------------------------------------------------------------
# The test that would have caught the original gap.
# ---------------------------------------------------------------------


class TestExportReturnsRealContent:
    """An end-to-end assertion on BYTES, which is what was missing."""

    def test_the_route_returns_the_exact_bytes_that_were_ingested(self, env):
        """The gap-closing test. Not 'returns 200' - returns THESE bytes."""
        payload = b'{"type":"user","uuid":"a1"}\n{"type":"assistant"}\n'
        with closing(open_db(env)) as conn:
            archive_id = store(conn, payload)
            token = uuid_of(conn, archive_id)

        response = client().get(f"{API}/archives/{token}/export")

        assert response.status_code == 200
        assert response.content == payload
        assert response.headers["X-Archive-Content-Sha256"] == (
            hashlib.sha256(payload).hexdigest()
        )
        assert response.headers["X-Archive-Content-Bytes"] == str(len(payload))
        assert response.headers["X-Archive-Verified"] == "before_send"

    def test_the_head_route_reports_size_without_reconstructing(self, env):
        """A caller must be able to learn 244 MB before asking for it."""
        payload = b'{"type":"user"}\n' * 40
        with closing(open_db(env)) as conn:
            token = uuid_of(conn, store(conn, payload))

        body = client().get(f"{API}/archives/{token}").json()

        assert body["result_status"] == "ok"
        assert body["result"]["raw_byte_length"] == len(payload)
        assert body["result"]["is_superseded"] is False

    def test_a_missing_archive_uuid_is_not_found_not_an_empty_success(self, env):
        """A silent empty 200 is the failure this whole surface is about."""
        absent = "00000000-0000-4000-8000-000000000000"
        response = client().get(f"{API}/archives/{absent}/export")
        assert response.status_code == 404
        assert response.json()["result_status"] == "not_found"


# ---------------------------------------------------------------------
# The chain case. Built by the real dedupe module, never hand-faked.
# ---------------------------------------------------------------------


class TestSupersessionChain:
    """A row whose own blob is empty must still export its own full bytes."""

    @staticmethod
    def build(conn, tmp_path, versions):
        """Grow one file through several appends, ingesting each version.

        Description: uses the REAL ``ingest_with_prefix_dedupe``, so the
          supersession pointers and sentinel blobs are written by the
          shipped code rather than by the test. A test that wrote those
          columns itself would be asserting its own arrangement.
        Inputs: conn, tmp_path (Path), versions (list[bytes]) - each a
          strict byte-prefix extension of the one before.
        Output: list[int] - the archive id of each version, in order.
        """
        path = tmp_path / "grow.jsonl"
        ids = []
        previous = None
        for data in versions:
            path.write_bytes(data)
            outcome = ingest_with_prefix_dedupe(
                conn, path, kind="session", source_path="grow.jsonl",
                existing_archive_id=previous,
            )
            previous = outcome.archive_id
            ids.append(previous)
        return ids

    def test_superseded_rows_hold_the_sentinel_and_still_export_in_full(
        self, env, tmp_path
    ):
        """The whole point: an empty blob is not an empty transcript."""
        versions = [
            b'{"n":1}\n',
            b'{"n":1}\n{"n":2}\n',
            b'{"n":1}\n{"n":2}\n{"n":3}\n',
            b'{"n":1}\n{"n":2}\n{"n":3}\n{"n":4}\n',
        ]
        with closing(open_db(env)) as conn:
            ids = self.build(conn, tmp_path, versions)

            # The fixture really did build a chain. If this fails, every
            # assertion below is testing head-of-chain rows and proves
            # nothing about supersession.
            superseded = conn.execute(
                "SELECT COUNT(*) FROM transcript_archives"
                " WHERE superseded_by_archive_id IS NOT NULL"
            ).fetchone()[0]
            assert superseded == len(versions) - 1, (
                "fixture built no supersession chain, so this test could "
                "not have exercised the chain walk"
            )
            for archive_id in ids[:-1]:
                row = conn.execute(
                    "SELECT content_gzip FROM transcript_archives WHERE id=?",
                    (archive_id,),
                ).fetchone()
                assert bytes(row["content_gzip"]) == SENTINEL
                assert zlib.decompress(bytes(row["content_gzip"])) == b""

            tokens = [uuid_of(conn, i) for i in ids]

        # Every version, including the ones whose own blob is empty,
        # comes back over HTTP as its own original bytes.
        c = client()
        for token, expected in zip(tokens, versions):
            response = c.get(f"{API}/archives/{token}/export")
            assert response.status_code == 200
            assert response.content == expected
            assert response.headers["X-Archive-Content-Bytes"] == str(
                len(expected)
            )

    def test_the_walked_chain_is_reported_on_the_response(self, env, tmp_path):
        """A client can tell a chain-walked export from a direct one."""
        versions = [b'{"n":1}\n', b'{"n":1}\n{"n":2}\n']
        with closing(open_db(env)) as conn:
            ids = self.build(conn, tmp_path, versions)
            first, last = uuid_of(conn, ids[0]), uuid_of(conn, ids[-1])

        c = client()
        assert c.get(f"{API}/archives/{first}/export").headers[
            "X-Archive-Chain-Walked"] == "true"
        assert c.get(f"{API}/archives/{last}/export").headers[
            "X-Archive-Chain-Walked"] == "false"

    def test_a_deep_chain_still_reconstructs(self, env, tmp_path):
        """Live chains reach depth 267, so one link is not a proof."""
        versions = [b"".join(b'{"n":%d}\n' % i for i in range(n))
                    for n in range(1, 32)]
        with closing(open_db(env)) as conn:
            ids = self.build(conn, tmp_path, versions)
            oldest = uuid_of(conn, ids[0])
            depth = 0
            cursor = ids[0]
            while True:
                nxt = conn.execute(
                    "SELECT superseded_by_archive_id FROM transcript_archives"
                    " WHERE id = ?", (cursor,)
                ).fetchone()[0]
                if nxt is None:
                    break
                cursor, depth = nxt, depth + 1
            assert depth == len(versions) - 1

        response = client().get(f"{API}/archives/{oldest}/export")
        assert response.content == versions[0]


# ---------------------------------------------------------------------
# Negative controls. Each breaks exactly one thing.
# ---------------------------------------------------------------------


class TestRefusals:
    """A verifier that always passes is worse than no verifier."""

    def test_a_corrupt_blob_is_refused_not_served(self, env):
        with closing(open_db(env)) as conn:
            archive_id = store(conn, b'{"n":1}\n')
            token = uuid_of(conn, archive_id)
            conn.execute(
                "UPDATE transcript_archives SET content_gzip = ? WHERE id = ?",
                (b"this is not zlib data", archive_id),
            )
            result = verified_archive_export(conn, token)
        assert result["status"] == ARCHIVE_EXPORT_RECONSTRUCTION_FAILED
        assert result["payload"] is None

        response = client().get(f"{API}/archives/{token}/export")
        assert response.status_code == 422
        assert response.json()["meta"]["refusal"] == (
            ARCHIVE_EXPORT_RECONSTRUCTION_FAILED
        )

    def test_a_wrong_recorded_hash_is_refused(self, env):
        """The HASH half, broken alone: the length still agrees."""
        payload = b'{"n":1}\n'
        with closing(open_db(env)) as conn:
            archive_id = store(conn, payload)
            token = uuid_of(conn, archive_id)
            conn.execute(
                "UPDATE transcript_archives SET content_sha256 = ?"
                " WHERE id = ?", ("0" * 64, archive_id),
            )
            result = verified_archive_export(conn, token)
        assert result["status"] == ARCHIVE_EXPORT_INTEGRITY_MISMATCH
        assert result["actual_bytes"] == len(payload)
        assert result["payload"] is None

    def test_a_wrong_recorded_length_is_refused(self, env):
        """The LENGTH half, broken alone: the hash still agrees.

        This is the case a hash-only check cannot see coming, and it is
        why both halves are compared.
        """
        payload = b'{"n":1}\n'
        with closing(open_db(env)) as conn:
            archive_id = store(conn, payload)
            token = uuid_of(conn, archive_id)
            conn.execute(
                "UPDATE transcript_archives SET raw_byte_length = ?"
                " WHERE id = ?", (len(payload) + 1, archive_id),
            )
            result = verified_archive_export(conn, token)
        assert result["status"] == ARCHIVE_EXPORT_INTEGRITY_MISMATCH
        assert result["actual_sha256"] == hashlib.sha256(payload).hexdigest()

    def test_a_dangling_chain_pointer_is_its_own_refusal_not_a_404(self, env):
        """A defect in the archive must not hide behind a routine 404."""
        with closing(open_db(env)) as conn:
            archive_id = store(conn, b'{"n":1}\n')
            token = uuid_of(conn, archive_id)
            # The foreign key exists precisely to stop this, so it is
            # lifted for the length of one statement to manufacture the
            # damaged state the refusal is supposed to catch.
            conn.execute("PRAGMA foreign_keys=OFF")
            conn.execute(
                "UPDATE transcript_archives SET superseded_by_archive_id = ?"
                " WHERE id = ?", (999999, archive_id),
            )
            conn.execute("PRAGMA foreign_keys=ON")
            result = verified_archive_export(conn, token)
        assert result["status"] == ARCHIVE_EXPORT_CHAIN_BROKEN

        response = client().get(f"{API}/archives/{token}/export")
        assert response.status_code == 422

    def test_an_oversize_row_is_refused_before_it_is_reconstructed(self, env):
        payload = b'{"n":1}\n'
        with closing(open_db(env)) as conn:
            archive_id = store(conn, payload)
            token = uuid_of(conn, archive_id)
            result = verified_archive_export(conn, token, max_bytes=1)
        assert result["status"] == ARCHIVE_EXPORT_TOO_LARGE
        assert result["payload"] is None

    def test_an_absent_row_is_not_found(self, env):
        with closing(open_db(env)) as conn:
            result = verified_archive_export(
                conn, "00000000-0000-4000-8000-000000000000"
            )
        assert result["status"] == ARCHIVE_EXPORT_NOT_FOUND

    def test_an_empty_transcript_is_served_and_not_mistaken_for_a_sentinel(
        self, env
    ):
        """17 live rows are genuinely empty; they are not superseded rows."""
        with closing(open_db(env)) as conn:
            token = uuid_of(conn, store(conn, b""))
            result = verified_archive_export(conn, token)
        assert result["status"] == ARCHIVE_EXPORT_OK
        assert result["payload"] == b""


# ---------------------------------------------------------------------
# The id space.
# ---------------------------------------------------------------------


class TestIdSpace:
    """An integer is ambiguous between two tables, so it is never guessed."""

    @pytest.mark.parametrize("value,expected", [
        ("0001c5d3-8ace-4213-87f7-f799ec4391c4", REF_ARCHIVE_UUID),
        ("21961", REF_INTEGER_ID),
        ("0", REF_INTEGER_ID),
        ("0001c5d38ace421387f7f799ec4391c4", REF_MALFORMED),
        ("{0001c5d3-8ace-4213-87f7-f799ec4391c4}", REF_MALFORMED),
        ("not-an-id", REF_MALFORMED),
        ("", REF_MALFORMED),
    ])
    def test_classification(self, value, expected):
        assert classify_archive_ref(value)[0] == expected

    def test_an_integer_is_refused_and_both_spaces_are_named(self, env):
        """The silent-wrong-transcript case, made loud."""
        with closing(open_db(env)) as conn:
            archive_id = store(conn, b'{"n":1}\n')
            token = uuid_of(conn, archive_id)

        response = client().get(f"{API}/archives/{archive_id}/export")

        assert response.status_code == 409
        meta = response.json()["meta"]
        assert meta["id_space"]["this_route_addresses"] == (
            "transcript_archives.archive_uuid"
        )
        assert "message_transcripts.id" in meta["id_space"]["ambiguous_between"]
        # It IS a real archive rowid, so the refusal hands back the uuid
        # rather than only complaining.
        assert meta["archive_uuid"] == token
        assert token in meta["retry_href"]

    def test_an_integer_that_is_no_archive_row_still_refuses_usefully(self, env):
        response = client().get(f"{API}/archives/999999/export")
        assert response.status_code == 409
        meta = response.json()["meta"]
        assert "archive_uuid" not in meta
        assert meta["message_model_href"].endswith("/transcripts/999999/export")

    def test_the_rowid_exchange_route_is_explicit_and_works(self, env):
        with closing(open_db(env)) as conn:
            archive_id = store(conn, b'{"n":1}\n')
            token = uuid_of(conn, archive_id)

        body = client().get(f"{API}/archives/by-rowid/{archive_id}").json()
        assert body["result"]["archive_uuid"] == token
        assert body["result"]["export_href"].endswith(f"{token}/export")

    def test_the_rowid_exchange_says_the_integer_may_be_a_message_id(self, env):
        response = client().get(f"{API}/archives/by-rowid/424242")
        assert response.status_code == 404
        assert "message_transcripts" in (
            response.json()["unevaluated"][0]["reason"]
        )

    def test_a_malformed_reference_is_a_client_error(self, env):
        response = client().get(f"{API}/archives/not-an-id/export")
        assert response.status_code == 400

    def test_the_message_model_404_names_its_own_store(self, env):
        """The honesty fix: a caller with the wrong id learns why."""
        response = client().get(f"{API}/transcripts/5000/export")
        assert response.status_code == 404
        meta = response.json()["meta"]
        assert meta["searched_table"] == "message_transcripts"
        assert meta["archive_rowid_exchange_href"].endswith("/by-rowid/5000")

    def test_rowid_helper_returns_none_rather_than_guessing(self, env):
        with closing(open_db(env)) as conn:
            assert archive_uuid_for_rowid(conn, 999999) is None


# ---------------------------------------------------------------------
# Against real data, read-only. Skipped when the live archive is absent.
# ---------------------------------------------------------------------

LIVE_ARCHIVE = (
    Path.home() / "Library" / "Application Support" / "CloudeCode"
    / "cloude-archive.db"
)


@pytest.mark.skipif(
    not LIVE_ARCHIVE.exists() or os.environ.get("CLOUDE_SKIP_LIVE_ARCHIVE"),
    reason="live cloude-archive.db not present on this machine",
)
class TestAgainstRealData:
    """Fixtures prove the logic; only real rows prove the population."""

    @staticmethod
    def read_only():
        """Open the LIVE archive read-only. Never opened for writing.

        Inputs: none. Output: sqlite3.Connection.
        """
        conn = sqlite3.connect(
            f"file:{LIVE_ARCHIVE}?mode=ro", uri=True, timeout=30.0
        )
        conn.row_factory = sqlite3.Row
        return conn

    def test_a_real_superseded_row_reconstructs_to_its_recorded_record(self):
        with closing(self.read_only()) as conn:
            row = conn.execute(
                "SELECT id, content_sha256, raw_byte_length,"
                "       compressed_byte_length"
                "  FROM transcript_archives"
                " WHERE superseded_by_archive_id IS NOT NULL"
                "   AND raw_byte_length > 0"
                " ORDER BY raw_byte_length DESC LIMIT 1"
            ).fetchone()
            if row is None:
                pytest.skip("no superseded rows in the live archive")
            # Its own blob really is the empty sentinel.
            assert row["compressed_byte_length"] == len(SENTINEL)
            data = export_archive(conn, row["id"])
            assert len(data) == row["raw_byte_length"]
            assert hashlib.sha256(data).hexdigest() == row["content_sha256"]

    def test_a_sample_of_real_rows_all_verify_through_the_shipped_path(self):
        """Both halves, on rows nobody chose for being easy."""
        with closing(self.read_only()) as conn:
            rows = conn.execute(
                "SELECT archive_uuid FROM transcript_archives"
                " WHERE raw_byte_length BETWEEN 1 AND 2000000"
                " ORDER BY id DESC LIMIT 40"
            ).fetchall()
            if not rows:
                pytest.skip("live archive holds no rows in that size band")
            for row in rows:
                result = verified_archive_export(conn, row["archive_uuid"])
                assert result["status"] == ARCHIVE_EXPORT_OK, (
                    f"{row['archive_uuid']} -> {result['detail']}"
                )

    def test_head_costs_nothing_on_the_largest_row(self):
        """Metadata must not reconstruct; this row is 244 MB."""
        with closing(self.read_only()) as conn:
            row = conn.execute(
                "SELECT archive_uuid, raw_byte_length"
                "  FROM transcript_archives"
                " ORDER BY raw_byte_length DESC LIMIT 1"
            ).fetchone()
            head = archive_head(conn, row["archive_uuid"])
        assert head["raw_byte_length"] == row["raw_byte_length"]
