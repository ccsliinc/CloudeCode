"""Shared fixture builder for the conversation-archive API tests.

The fixture database is built through the archive project's OWN models and
FTS5 DDL rather than a hand-written CREATE TABLE list. A fixture that can
drift from the real schema tests nothing, and this schema is genuinely
intricate (external-content FTS5 with three sync triggers, a nullable
``session_kind``, ``progress`` rows that are not messages).
"""

from __future__ import annotations

import datetime as _dt
import importlib.util
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ---- env bootstrap so ``src.config`` import succeeds --------------------
# src.config exits the process when TOTP/JWT secrets are absent, so these
# must be set BEFORE the first src.* import. Same pattern as
# tests/test_upload_file.py.
import os
import sys
import tempfile

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_hist_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_hist_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402

from src.api.auth import require_auth
from src.config import HistoryConfig

HAS_ARCHIVE = (
    importlib.util.find_spec("sqlalchemy") is not None
    and importlib.util.find_spec("claude_history") is not None
)
requires_archive = pytest.mark.skipif(
    not HAS_ARCHIVE,
    reason="optional sqlalchemy / claude_history packages are not installed",
)


def build_client(config: HistoryConfig) -> TestClient:
    """Build a test client serving only the history router.

    Args:
        config: the ``history`` block the router should see.

    Returns:
        TestClient: auth bypassed, router mounted at /api/v1/history.
    """
    from src.api import history as history_module

    app = FastAPI()
    app.include_router(history_module.router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: True
    history_module.get_history_config = lambda: config  # type: ignore[assignment]
    return TestClient(app)


def seed_fixture_db(
    db_path: Path,
    ingest_completed_at: Any = "sentinel-now",
    ingest_status: str = "completed",
    include_ingest_run: bool = True,
) -> None:
    """Create and populate a small archive database at ``db_path``.

    Built through the archive package's own models and FTS DDL so the
    fixture cannot drift from the schema the API queries in production.

    Contents: one host, one project, one main session with a thread that
    mixes user, assistant, progress, machinery and a compaction boundary,
    plus one subagent session.

    Args:
        db_path: where to write the SQLite file.
        ingest_completed_at: ``completed_at`` for the seeded ingest run.
            The literal string "sentinel-now" means "now", which is what
            makes freshness read ``current``.
        ingest_status: ``ingest_runs.status`` for the seeded run.
        include_ingest_run: when False, no run is written at all, which is
            the ``unknown`` freshness case.

    Returns:
        None.
    """
    from claude_history.db import build_engine, build_session_factory, init_schema
    from claude_history.models import (
        CompactionEvent,
        Host,
        IngestRun,
        Project,
        Session,
    )

    engine = build_engine(str(db_path))
    init_schema(engine)
    factory = build_session_factory(engine)
    now = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)

    with factory() as db:
        host = Host(machine_id="test-host", display_name="test")
        db.add(host)
        db.flush()

        project = Project(host_id=host.id, slug="-tmp-proj", guessed_path="/tmp/proj")
        db.add(project)
        db.flush()

        session = Session(
            host_id=host.id,
            project_id=project.id,
            session_uuid="11111111-1111-1111-1111-111111111111",
            source_file_path="/tmp/proj/session.jsonl",
            cwd="/tmp/proj",
            git_branch="main",
            cc_version="2.0.0",
            model="claude-opus-5",
            started_at=now - _dt.timedelta(hours=2),
            ended_at=now,
            message_count=8,
            sidechain_message_count=1,
            session_kind="main",
        )
        subagent = Session(
            host_id=host.id,
            project_id=project.id,
            session_uuid="agent:aaaa111",
            source_file_path="/tmp/proj/session/subagents/agent-aaaa111.jsonl",
            started_at=now - _dt.timedelta(hours=1),
            message_count=2,
            is_subagent_session=True,
            session_kind="subagent",
            parent_session_id=None,  # set below, once session.id exists
            agent_type="worker",
            agent_id="aaaa111",
        )
        db.add(session)
        db.flush()
        subagent.parent_session_id = session.id
        db.add(subagent)
        db.flush()

        # seq 1..8. Deliberately NOT in id order for the machinery rows, so
        # a test that passes only because insertion order matched seq order
        # would fail.
        rows = [
            _msg(host.id, session.id, 1, "user", role="user", text="first question"),
            _msg(
                host.id,
                session.id,
                2,
                "assistant",
                role="assistant",
                text="thinking about restic " + ("x" * 400),
                has_tool_use=True,
                tool_use_ids_json='["toolu_1"]',
            ),
            _msg(host.id, session.id, 3, "progress", tool_use_id="toolu_1"),
            _msg(host.id, session.id, 4, "progress", tool_use_id="toolu_1"),
            _msg(host.id, session.id, 5, "queue-operation"),
            _msg(
                host.id,
                session.id,
                6,
                "user",
                role="user",
                text="tool output came back",
                has_tool_result=True,
            ),
            _msg(
                host.id,
                session.id,
                7,
                "system",
                text="compacted",
                is_compact_boundary=True,
                compact_subtype="compact_boundary",
            ),
            _msg(host.id, session.id, 8, "user", role="user", text="second question"),
        ]
        db.add_all(rows)
        db.add(
            _msg(host.id, subagent.id, 1, "user", role="user", text="agent brief")
        )
        db.flush()

        boundary = [r for r in rows if r.is_compact_boundary][0]
        db.add(
            CompactionEvent(
                session_id=session.id,
                message_id=boundary.id,
                occurred_at=now,
                subtype="compact_boundary",
                preceding_message_count=6,
            )
        )

        if include_ingest_run:
            completed = (
                now if ingest_completed_at == "sentinel-now" else ingest_completed_at
            )
            db.add(
                IngestRun(
                    host_id=host.id,
                    started_at=now,
                    completed_at=completed,
                    status=ingest_status,
                    files_scanned=1,
                    files_ingested=1,
                    records_ingested=len(rows),
                )
            )
        db.commit()
    engine.dispose()


def _msg(host_id: int, session_id: int, seq: int, record_type: str, **kwargs: Any):
    """Build one Message row for the fixture.

    Args:
        host_id: Host.id.
        session_id: Session.id.
        seq: ``seq_in_file``.
        record_type: the record type.
        **kwargs: role, text, tool_use_id and the boolean flags.

    Returns:
        claude_history.models.Message: unsaved row.
    """
    from claude_history.models import Message

    return Message(
        host_id=host_id,
        session_id=session_id,
        uuid=f"m-{session_id}-{seq}",
        seq_in_file=seq,
        record_type=record_type,
        role=kwargs.get("role"),
        text_content=kwargs.get("text"),
        tool_use_id=kwargs.get("tool_use_id"),
        tool_use_ids_json=kwargs.get("tool_use_ids_json"),
        has_tool_use=kwargs.get("has_tool_use", False),
        has_tool_result=kwargs.get("has_tool_result", False),
        is_compact_boundary=kwargs.get("is_compact_boundary", False),
        compact_subtype=kwargs.get("compact_subtype"),
        timestamp=_dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None),
        raw_stored=False,
    )


def enabled_config(db_path: Path, **overrides: Any) -> HistoryConfig:
    """Build an enabled HistoryConfig pointed at a fixture database.

    Args:
        db_path: path to the fixture DB.
        **overrides: any HistoryConfig field to override.

    Returns:
        HistoryConfig: enabled block.
    """
    fields: dict[str, Any] = {"enabled": True, "db_path": str(db_path)}
    fields.update(overrides)
    return HistoryConfig(**fields)


