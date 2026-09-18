"""The conversation binding, end to end, against a real database.

**WHAT THIS GUARDS, AND WHY A GREEN SUITE MISSED IT.**
``sessions.claude_session_uuid`` is how the app finds the transcript file
for a session. Its only writer was the ``SessionStart`` hook; deleting
the hook route left the column NULL on every session created afterwards,
and nothing went red, because every test that named the column drove the
writer directly. The damage was one tier down: the transcript reader is
handed that column and answers "no claude conversation is bound to this
row" without it, so the evidence a finished turn, an unread finish and a
sub-agent wait are all derived from could not be read at all.

So these tests assert the TIER, not the call. Each one reads the
transcript evidence before the watcher's side-effect pass and again
after, and the pair is the claim: the tier goes from blind to reading a
real file, off a real registry record, through a real database.

**THE REGISTRY DIRECTORY, THE TRANSCRIPT CORPUS AND THE DATABASE ARE ALL
THROWAWAY.** ``$HOME`` is redirected, so ``~/.claude/sessions`` and
``~/.claude/projects`` here are empty directories this test made; the
state directory is ``tmp_path``. Nothing reads or writes the developer's
own install.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_acb_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_acb_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.attention.evidence import Evidence, FAMILY_CLAUDE
from src.core.attention.side_effects import AttentionSideEffects
from src.core.attention.watcher import Observation, WatchTarget
from src.core.claude_transcript_correlate import slugify_project_dir
from src.core.db import connect, db_path_for, transaction
from src.core.db_migration import ensure_db_migrated
from src.core.db_models import (
    SESSION_CLAUDE_UUID_SOURCE_CORRELATED,
    SESSION_CLAUDE_UUID_SOURCE_REGISTRY,
    SESSION_ORIGIN_CREATED,
)
from src.core.session_identity import record_instance
from src.core.session_manager import SessionManager
from src.core.session_status import LIVENESS_LIVE
from src.core.session_store import list_sessions
from src.core.attention.evidence import (
    AttentionVerdict,
    REASON_TURN_ENDED,
    STATE_DONE_IDLE,
    TIER_REGISTRY,
)
from src.models import Session, SessionStatus

SOCKET = "cloude"
TMUX_NAME = "cloude_bindproj"
EPOCH = 1_789_000_500
APP_SESSION_ID = "ses_bind"
CONVERSATION = "11111111-2222-3333-4444-555555555555"
OTHER_CONVERSATION = "99999999-8888-7777-6666-555555555555"
NOW = datetime(2026, 9, 13, 18, 0, 0, tzinfo=timezone.utc)


class _StubSettings:
    """Just enough of ``Settings`` for ``SessionManager.__init__``.

    Inputs: root (Path) - the throwaway state directory.
    Output: n/a (test double).
    """

    def __init__(self, root: Path):
        """Point every path at the throwaway root. Output: None."""
        self._root = root
        self.port = 5001
        (root / "logs").mkdir(exist_ok=True)

    def get_pinned_themes_path(self) -> Path:
        """Output: Path."""
        return self._root / "pinned_themes.json"

    def get_unread_state_path(self) -> Path:
        """Output: Path."""
        return self._root / "unread_state.json"

    @property
    def log_directory(self) -> str:
        """Output: str."""
        return str(self._root / "logs")

    def get_session_metadata_path(self) -> Path:
        """Output: Path."""
        return self._root / "logs" / "session_metadata.json"

    def get_state_dir(self) -> Path:
        """Output: Path."""
        return self._root


class _FakeBackend:
    """Bare enough of a SessionBackend for the tmux name lookups.

    Inputs: tmux_session (str).
    Output: n/a (test double).
    """

    def __init__(self, tmux_session: str):
        """Output: None."""
        self.tmux_session = tmux_session
        self.socket_name = SOCKET

    def is_alive(self) -> bool:
        """Output: bool - always True; liveness is not what is under test."""
        return True


class _Listing:
    """A stand-in for ``TmuxListing`` carrying its ok/sessions contract.

    Inputs: ok (bool), sessions (list | None).
    Output: n/a (test double).
    """

    def __init__(self, ok: bool, sessions=None):
        """Output: None."""
        self.ok = ok
        self.sessions = sessions or []
        self.reason = None


def _write_registry_record(home: Path, *, session_uuid: str) -> Path:
    """Write one ``~/.claude/sessions/<pid>.json`` the real scanner reads.

    Description: the pid is THIS process, because a record whose pid is
      measurably gone is refused as stale by the real index - which is
      the correct behaviour and would make this test assert nothing.
    Inputs: home (Path) - the redirected home. session_uuid (str) - the
      conversation the record names.
    Output: Path - the file written.
    """
    directory = home / ".claude" / "sessions"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / ("%d.json" % os.getpid())
    path.write_text(
        json.dumps(
            {
                "pid": os.getpid(),
                "status": "idle",
                "sessionId": session_uuid,
                "cwd": "/tmp",
                "tmux": "%s:@0.%%0" % TMUX_NAME,
                "version": "2.1.266",
                "startedAt": (EPOCH + 60) * 1000,
                "statusUpdatedAt": (EPOCH + 60) * 1000,
            }
        ),
        encoding="utf-8",
    )
    return path


def _write_transcript(home: Path, working_dir: str, uuid: str) -> Path:
    """Write a transcript where ``conversation_presence`` will find it.

    Description: the mtime is backdated so the tail classifier is reading
      a conversation AT REST rather than one that was just appended to,
      which is the state this test wants to prove became readable.
    Inputs: home (Path), working_dir (str), uuid (str).
    Output: Path - the transcript.
    """
    directory = home / ".claude" / "projects" / slugify_project_dir(working_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / ("%s.jsonl" % uuid)
    path.write_text(
        "".join(
            json.dumps(record) + "\n"
            for record in (
                {"type": "user", "message": {"role": "user", "content": "hi"}},
                {
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "done"}],
                        "stop_reason": "end_turn",
                    },
                },
                # THE TURN-END RECORD, and it is the whole point of the
                # file: it is what the transcript tier reads, and it is
                # unreachable while the row carries no conversation.
                {
                    "type": "system",
                    "subtype": "turn_duration",
                    "durationMs": 75930,
                    "messageCount": 3,
                    "timestamp": "2026-09-13T17:00:00.000Z",
                    "uuid": "2c6a3bac-0183-47b6-a32c-67712e89b6e9",
                    "cwd": working_dir,
                    "sessionId": uuid,
                    "version": "2.1.266",
                },
            )
        ),
        encoding="utf-8",
    )
    stamp = time.time() - 3600
    os.utime(path, (stamp, stamp))
    return path


@pytest.fixture()
def harness(monkeypatch, tmp_path):
    """A manager, a migrated database, one anchored row, a redirected home.

    Inputs: monkeypatch, tmp_path.
    Output: (SessionManager, Path state_dir, Path home, str working_dir).
    """
    home = tmp_path / "home"
    (home / ".claude" / "sessions").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    # THE SUITE-WIDE FIXTURE POINTS THE REGISTRY SCAN AT AN EMPTY
    # DIRECTORY so no test can read the developer's live claude
    # processes. This file is one of the tests that wants a record, so it
    # re-points the same seam at a directory it wrote itself. Redirecting
    # $HOME alone would not do it: that fixture replaced the function.
    monkeypatch.setattr(
        "src.core.attention.registry_read.default_registry_directory",
        lambda: str(home / ".claude" / "sessions"),
    )

    state = tmp_path / "state"
    state.mkdir()
    working_dir = str(tmp_path / "proj")
    os.makedirs(working_dir, exist_ok=True)

    monkeypatch.setattr(
        "src.core.session_manager.settings", _StubSettings(state)
    )
    # THE AGENT INFERENCE IS NOT UNDER TEST HERE and it shells out to
    # tmux on the production socket, which the suite's socket guard
    # blocks and logs. Replaced so this file measures the binding and
    # nothing else.
    monkeypatch.setattr(
        "src.core.session_agent_infer_apply.apply_agent_inference",
        lambda manager, session_id, tmux_name: None,
    )
    ensure_db_migrated(state, 4, "0.8.2")
    with closing(connect(db_path_for(state))) as conn:
        with transaction(conn):
            record_instance(
                conn,
                socket=SOCKET,
                name=TMUX_NAME,
                epoch=EPOCH,
                origin=SESSION_ORIGIN_CREATED,
                working_dir=working_dir,
            )

    manager = SessionManager()
    manager._registry.sessions[APP_SESSION_ID] = Session(
        id=APP_SESSION_ID,
        pty_pid=None,
        working_dir=working_dir,
        status=SessionStatus.RUNNING,
        tmux_session=TMUX_NAME,
    )
    manager._registry.backends[APP_SESSION_ID] = _FakeBackend(TMUX_NAME)
    manager._registry.subscribers.setdefault(APP_SESSION_ID, [])
    manager._instance_epochs[APP_SESSION_ID] = EPOCH
    monkeypatch.setattr(
        manager,
        "list_attachable_sessions_with_socket",
        lambda: (
            SOCKET,
            _Listing(True, [{"name": TMUX_NAME, "created_at_epoch": EPOCH}]),
        ),
    )
    return manager, state, home, working_dir


def _reads(manager):
    """The two file-backed tiers for the harness session, read for real.

    Inputs: manager (SessionManager).
    Output: tuple[RegistryRecord, TranscriptFacts].
    """
    return manager._attention_reads_for(
        session_id=APP_SESSION_ID, tmux_name=TMUX_NAME, epoch=EPOCH
    )


def _observe(manager, registry, transcript):
    """Run one watcher observation through the real side-effect layer.

    Inputs: manager (SessionManager). registry (RegistryRecord).
      transcript (TranscriptFacts).
    Output: None.
    """
    effects = AttentionSideEffects(manager)
    effects.on_observation(
        WatchTarget(
            session_id=APP_SESSION_ID, key="%s@%d" % (TMUX_NAME, EPOCH)
        ),
        Observation(
            verdict=AttentionVerdict(
                state=STATE_DONE_IDLE,
                reason=REASON_TURN_ENDED,
                tier=TIER_REGISTRY,
            ),
            evidence=Evidence(
                tmux_liveness=LIVENESS_LIVE,
                agent_family=FAMILY_CLAUDE,
                registry=registry,
                transcript=transcript,
                pane=None,
                now=NOW,
            ),
            new_user_prompt_at=None,
            transcript_appended=False,
        ),
    )


def _row(state):
    """The anchored session row, read straight back out of sqlite.

    Inputs: state (Path) - the state directory.
    Output: dict - the row carrying this tmux instance.
    """
    with closing(connect(db_path_for(state))) as conn:
        rows = list_sessions(conn, include_lineage=True)
    anchored = [r for r in rows if r["tmux_created_epoch"] == EPOCH]
    assert len(anchored) == 1
    return anchored[0]


def test_the_transcript_tier_is_blind_until_the_binding_runs(harness):
    """THE DEFECT, STATED AS A TEST. Without the binding the reader has
    no conversation to look for, so it refuses - and that refusal is not
    "this session is at rest", it is "we could not look"."""
    manager, _state, home, working_dir = harness
    _write_registry_record(home, session_uuid=CONVERSATION)
    _write_transcript(home, working_dir, CONVERSATION)

    _registry, transcript = _reads(manager)
    assert transcript.found is False
    assert "no claude conversation is bound to this row" in transcript.detail


def test_a_live_registry_record_binds_the_row_and_opens_the_tier(harness):
    """THE FIX, MEASURED AT THE TIER RATHER THAN AT THE CALL.

    One observation, and the same reader that refused above now locates
    a real file and reads real facts out of it. The column carries the
    conversation and says where it came from.
    """
    manager, state, home, working_dir = harness
    _write_registry_record(home, session_uuid=CONVERSATION)
    _write_transcript(home, working_dir, CONVERSATION)

    registry, transcript = _reads(manager)
    assert registry.known is True
    assert transcript.found is False

    _observe(manager, registry, transcript)

    row = _row(state)
    assert row["claude_session_uuid"] == CONVERSATION
    assert row["claude_session_uuid_source"] == SESSION_CLAUDE_UUID_SOURCE_REGISTRY

    _registry_after, transcript_after = _reads(manager)
    assert transcript_after.found is True
    assert transcript_after.turn_end_at is not None
    assert "no claude conversation is bound" not in (
        transcript_after.detail or ""
    )


def test_a_second_tick_issues_no_second_write(harness):
    """IDEMPOTENCE, ASSERTED AGAINST THE TABLE AND THE CLOCK.

    The steady state of this job is a session that is already bound, and
    it is entered within one tick of every session's life. If it wrote
    every two seconds it would touch ``updated_at`` on every row forever,
    which is a write storm nothing would report.
    """
    manager, state, home, working_dir = harness
    _write_registry_record(home, session_uuid=CONVERSATION)
    _write_transcript(home, working_dir, CONVERSATION)

    registry, transcript = _reads(manager)
    _observe(manager, registry, transcript)
    first = _row(state)

    effects = AttentionSideEffects(manager)
    for _ in range(3):
        registry, transcript = _reads(manager)
        effects._bind_conversation(APP_SESSION_ID, TMUX_NAME, registry)

    after = _row(state)
    assert after["claude_session_uuid"] == CONVERSATION
    assert after["updated_at"] == first["updated_at"]


def test_a_row_already_bound_elsewhere_is_never_rewritten(harness):
    """THE MISMATCH RULE. A row holding conversation A is not moved to B
    by a record that names B, and no lineage row is minted for B either.

    The refusal is upstream and is asserted as such: the real registry
    reader is handed the row's own uuid and answers a REFUSAL for a
    record that disagrees, so the binding never sees a believable record
    at all. A guess must never outrank a record, and the record on the
    row was written by a conversation that demonstrably ran in this pane.
    """
    manager, state, home, working_dir = harness
    with closing(connect(db_path_for(state))) as conn:
        with transaction(conn):
            conn.execute(
                "UPDATE sessions SET claude_session_uuid = ?, "
                "claude_session_uuid_source = ? WHERE tmux_created_epoch = ?",
                (
                    OTHER_CONVERSATION,
                    SESSION_CLAUDE_UUID_SOURCE_CORRELATED,
                    EPOCH,
                ),
            )
    before_rows = len(
        [r for r in _all_rows(state) if r["claude_session_uuid"]]
    )

    _write_registry_record(home, session_uuid=CONVERSATION)
    registry, transcript = _reads(manager)
    assert registry.known is False

    _observe(manager, registry, transcript)

    row = _row(state)
    assert row["claude_session_uuid"] == OTHER_CONVERSATION
    assert row["claude_session_uuid_source"] == SESSION_CLAUDE_UUID_SOURCE_CORRELATED
    assert (
        len([r for r in _all_rows(state) if r["claude_session_uuid"]])
        == before_rows
    )


def _all_rows(state):
    """Every sessions row, lineage children included.

    Inputs: state (Path).
    Output: list[dict].
    """
    with closing(connect(db_path_for(state))) as conn:
        return list_sessions(conn, include_lineage=True)
