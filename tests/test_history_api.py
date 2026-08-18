"""Tests for the read-only conversation-archive API.

The two tests that matter most on a machine WITHOUT the optional archive
packages -- default-off config and the missing-database path -- deliberately
do not require them, because that is the configuration most installs are in.
Fixture construction lives in ``tests/history_fixture.py``.
"""

from __future__ import annotations

import datetime as _dt
from pathlib import Path
from typing import Iterator

import pytest

from tests.history_fixture import (
    build_client,
    enabled_config,
    requires_archive,
    seed_fixture_db,
)
from src.config import HistoryConfig


@pytest.fixture
def archive(tmp_path: Path) -> Iterator[Path]:
    """Provide a seeded fixture archive and reset the engine cache.

    Yields:
        Path: the fixture database path.
    """
    from src.core.history_db import reset_engine_cache

    db_path = tmp_path / "claude_history.db"
    seed_fixture_db(db_path)
    reset_engine_cache()
    yield db_path
    reset_engine_cache()

# --- default-off and missing-database paths (no optional packages needed) ---


def test_history_defaults_to_disabled() -> None:
    """A HistoryConfig with no fields set is disabled and unconfigured."""
    config = HistoryConfig()
    assert config.enabled is False
    assert config.db_path == ""


def test_app_config_block_defaults_off() -> None:
    """The AuthConfig-level history block defaults to disabled.

    This is the "Cloude Code starts normally without the archive" contract
    expressed at the config layer: nothing about an install that has never
    heard of the archive turns this on.
    """
    from src.config import AuthConfig

    config = AuthConfig(totp_secret="x", jwt_secret="y")
    assert config.history.enabled is False


def test_disabled_returns_unavailable_not_empty() -> None:
    """A disabled viewer says so; it does not return an empty project list."""
    client = build_client(HistoryConfig(enabled=False))
    body = client.get("/api/v1/history/projects").json()
    assert body["status"] == "unavailable"
    assert body["reason"] == "disabled"
    assert "items" not in body


def test_missing_db_returns_unavailable_with_reason(tmp_path: Path) -> None:
    """A nonexistent database is db_missing, not a 500 and not empty."""
    client = build_client(enabled_config(tmp_path / "nope.db"))
    response = client.get("/api/v1/history/status")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "unavailable"
    assert body["reason"] == "db_missing"
    assert str(tmp_path / "nope.db") in body["message"]


def test_unconfigured_path_is_its_own_reason() -> None:
    """Enabled with an empty db_path is db_not_configured, not db_missing."""
    client = build_client(HistoryConfig(enabled=True, db_path=""))
    body = client.get("/api/v1/history/sessions").json()
    assert body["status"] == "unavailable"
    assert body["reason"] == "db_not_configured"


# --- real reads against the fixture archive --------------------------------


@requires_archive
def test_status_reports_current_and_counts(archive: Path) -> None:
    """A just-ingested archive reads current, with real counts."""
    client = build_client(enabled_config(archive))
    body = client.get("/api/v1/history/status").json()
    assert body["status"] == "ok"
    assert body["freshness"]["state"] == "current"
    assert body["counts"] == {"projects": 1, "sessions": 2}
    assert body["fts_available"] is True
    assert body["caveats"] == []


@requires_archive
def test_freshness_stale_still_answers_with_a_caveat(tmp_path: Path) -> None:
    """A stale archive answers ok and says it is stale. It does not fail."""
    from src.core.history_db import reset_engine_cache

    db_path = tmp_path / "stale.db"
    old = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None) - _dt.timedelta(hours=12)
    seed_fixture_db(db_path, ingest_completed_at=old)
    reset_engine_cache()
    client = build_client(enabled_config(db_path))
    body = client.get("/api/v1/history/status").json()
    assert body["status"] == "ok"
    assert body["freshness"]["state"] == "stale"
    assert body["caveats"] and "last ingested" in body["caveats"][0]
    reset_engine_cache()


@requires_archive
def test_freshness_unknown_is_not_current(tmp_path: Path) -> None:
    """An empty ingest_runs table is unknown, never current."""
    from src.core.history_db import reset_engine_cache

    db_path = tmp_path / "unknown.db"
    seed_fixture_db(db_path, include_ingest_run=False)
    reset_engine_cache()
    client = build_client(enabled_config(db_path))
    body = client.get("/api/v1/history/status").json()
    assert body["freshness"]["state"] == "unknown"
    assert body["freshness"]["lag_seconds"] is None
    assert "CANNOT BE DETERMINED" in body["caveats"][0]
    reset_engine_cache()


@requires_archive
def test_running_ingest_run_is_not_a_completed_one(tmp_path: Path) -> None:
    """A run still in flight does not count as a completed ingest."""
    from src.core.history_db import reset_engine_cache

    db_path = tmp_path / "running.db"
    seed_fixture_db(db_path, ingest_completed_at=None, ingest_status="running")
    reset_engine_cache()
    client = build_client(enabled_config(db_path))
    assert client.get("/api/v1/history/status").json()["freshness"]["state"] == "unknown"
    reset_engine_cache()


@requires_archive
def test_hard_stale_archive_is_unavailable(tmp_path: Path) -> None:
    """Past the hard threshold, a confident answer is worse than none."""
    from src.core.history_db import reset_engine_cache

    db_path = tmp_path / "ancient.db"
    ancient = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None) - _dt.timedelta(days=10)
    seed_fixture_db(db_path, ingest_completed_at=ancient)
    reset_engine_cache()
    client = build_client(enabled_config(db_path))
    body = client.get("/api/v1/history/projects").json()
    assert body["status"] == "unavailable"
    assert body["reason"] == "index_stale"
    reset_engine_cache()


@requires_archive
def test_projects_split_counts_by_kind(archive: Path) -> None:
    """A project's session count excludes subagent transcripts."""
    client = build_client(enabled_config(archive))
    body = client.get("/api/v1/history/projects").json()
    assert body["status"] == "ok"
    project = body["items"][0]
    assert project["session_count"] == 1
    assert project["subagent_session_count"] == 1
    assert project["unclassified_session_count"] == 0


@requires_archive
def test_sessions_default_to_main_kind_with_header_fields(archive: Path) -> None:
    """The session list defaults to conversations and carries its header."""
    client = build_client(enabled_config(archive))
    body = client.get("/api/v1/history/sessions").json()
    assert body["status"] == "ok"
    assert body["total"] == 1
    row = body["items"][0]
    assert row["cwd"] == "/tmp/proj"
    assert row["git_branch"] == "main"
    assert row["cc_version"] == "2.0.0"
    assert row["model"] == "claude-opus-5"
    assert row["message_count"] == 8
    assert row["sidechain_message_count"] == 1
    assert row["subagent_count"] == 1


@requires_archive
def test_sessions_limit_is_capped_server_side(archive: Path) -> None:
    """A client cannot page past history.max_page_size."""
    client = build_client(enabled_config(archive, max_page_size=2))
    body = client.get("/api/v1/history/sessions?limit=5000&kind=any").json()
    assert body["limit"] == 2
    assert body["limit_requested"] == 5000


@requires_archive
def test_messages_are_ordered_by_seq_and_fold_progress(archive: Path) -> None:
    """Ordering is seq_in_file; progress folds into its parent turn."""
    client = build_client(enabled_config(archive))
    session_id = client.get("/api/v1/history/sessions").json()["items"][0]["id"]
    body = client.get(f"/api/v1/history/sessions/{session_id}/messages").json()
    assert body["status"] == "ok"
    seqs = [m["seq_in_file"] for m in body["items"]]
    assert seqs == sorted(seqs)
    assert "progress" not in {m["record_type"] for m in body["items"]}
    assistant = [m for m in body["items"] if m["record_type"] == "assistant"][0]
    assert assistant["folded_progress_count"] == 2
    assert body["unattributed_progress"] == 0


@requires_archive
def test_machinery_is_excluded_unless_asked_for(archive: Path) -> None:
    """Bookkeeping types are hidden by default and appear on request."""
    client = build_client(enabled_config(archive))
    session_id = client.get("/api/v1/history/sessions").json()["items"][0]["id"]
    default = client.get(f"/api/v1/history/sessions/{session_id}/messages").json()
    assert "queue-operation" not in {m["record_type"] for m in default["items"]}
    with_machinery = client.get(
        f"/api/v1/history/sessions/{session_id}/messages?include_machinery=true"
    ).json()
    assert "queue-operation" in {m["record_type"] for m in with_machinery["items"]}
    # progress is never a message, under either flag
    assert "progress" not in {m["record_type"] for m in with_machinery["items"]}


@requires_archive
def test_message_paging_walks_the_thread(archive: Path) -> None:
    """after_seq paging returns every visible row exactly once."""
    client = build_client(enabled_config(archive))
    session_id = client.get("/api/v1/history/sessions").json()["items"][0]["id"]
    seen: list[int] = []
    cursor = 0
    for _ in range(10):
        body = client.get(
            f"/api/v1/history/sessions/{session_id}/messages"
            f"?after_seq={cursor}&limit=2"
        ).json()
        seen.extend(m["seq_in_file"] for m in body["items"])
        if not body["has_more"]:
            break
        cursor = body["next_after_seq"]
    assert seen == [1, 2, 6, 7, 8]
    assert len(seen) == len(set(seen))


@requires_archive
def test_long_bodies_are_truncated_and_flagged(archive: Path) -> None:
    """An over-cap body is clipped AND says it was clipped."""
    client = build_client(enabled_config(archive, max_text_chars=256))
    session_id = client.get("/api/v1/history/sessions").json()["items"][0]["id"]
    body = client.get(f"/api/v1/history/sessions/{session_id}/messages").json()
    clipped = [m for m in body["items"] if m["text_truncated"]]
    assert clipped
    assert body["bodies_truncated"] == len(clipped)
    assert all(len(m["text_content"]) == 256 for m in clipped)


@requires_archive
def test_outline_maps_turns_compaction_and_tool_counts(archive: Path) -> None:
    """The outline lists real user turns, the compaction event, tool counts."""
    client = build_client(enabled_config(archive))
    session_id = client.get("/api/v1/history/sessions").json()["items"][0]["id"]
    body = client.get(f"/api/v1/history/sessions/{session_id}/outline").json()
    assert body["status"] == "ok"
    assert body["session"]["cwd"] == "/tmp/proj"
    assert [t["stub"] for t in body["turns"]] == ["first question", "second question"]
    assert body["turns"][0]["tool_calls_after"] == 1
    assert body["tool_call_total"] == 1
    assert len(body["compaction_events"]) == 1
    assert body["compaction_events"][0]["subtype"] == "compact_boundary"
    assert body["truncated"] is False


@requires_archive
def test_outline_truncation_is_declared(archive: Path) -> None:
    """When the turn cap binds, the response says so."""
    client = build_client(enabled_config(archive, max_outline_turns=1))
    session_id = client.get("/api/v1/history/sessions").json()["items"][0]["id"]
    body = client.get(f"/api/v1/history/sessions/{session_id}/outline").json()
    assert body["truncated"] is True
    assert "capped" in body["truncation_reason"]


@requires_archive
def test_missing_session_is_unavailable_not_empty(archive: Path) -> None:
    """A session that does not exist is not an empty conversation."""
    client = build_client(enabled_config(archive))
    for path in ("outline", "messages"):
        body = client.get(f"/api/v1/history/sessions/999999/{path}").json()
        assert body["status"] == "unavailable"
        assert body["reason"] == "session_not_found"


@requires_archive
def test_search_finds_hits_in_session(archive: Path) -> None:
    """Session-scoped FTS returns ranked hits with snippets."""
    client = build_client(enabled_config(archive))
    session_id = client.get("/api/v1/history/sessions").json()["items"][0]["id"]
    body = client.get(
        f"/api/v1/history/search?q=restic&session_id={session_id}"
    ).json()
    assert body["status"] == "ok"
    assert body["count"] == 1
    assert "restic" in body["items"][0]["snippet"]


@requires_archive
def test_search_zero_hits_is_no_matches_not_unavailable(archive: Path) -> None:
    """Searched and found nothing is its own outcome."""
    client = build_client(enabled_config(archive))
    session_id = client.get("/api/v1/history/sessions").json()["items"][0]["id"]
    body = client.get(
        f"/api/v1/history/search?q=zzzznotpresent&session_id={session_id}"
    ).json()
    assert body["status"] == "no_matches"
    assert body["items"] == []


@requires_archive
def test_search_syntax_error_is_not_zero_results(archive: Path) -> None:
    """A malformed FTS5 expression is never reported as nothing found."""
    client = build_client(enabled_config(archive))
    session_id = client.get("/api/v1/history/sessions").json()["items"][0]["id"]
    body = client.get(
        f"/api/v1/history/search?q=%22unbalanced&session_id={session_id}"
    ).json()
    assert body["status"] == "unavailable"
    assert body["reason"] == "query_syntax_error"


@requires_archive
def test_absent_archive_package_is_dependency_missing(archive: Path) -> None:
    """A missing optional package is a named reason, not a crash.

    Most installs have neither ``sqlalchemy`` nor ``claude_history``. That
    configuration must produce the third outcome, because a 500 there reads
    as "Cloude Code is broken" rather than "this optional module is not
    installed".
    """
    import sys
    from unittest.mock import patch

    client = build_client(enabled_config(archive))
    with patch.dict(sys.modules, {"claude_history.search": None}):
        body = client.get("/api/v1/history/projects").json()
    assert body["status"] == "unavailable"
    assert body["reason"] == "dependency_missing"
