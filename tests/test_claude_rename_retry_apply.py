"""The retry seam: does a pass actually spawn a push, and when does it not.

WHAT A PURE TEST CANNOT ASK. The ladder next door is exhaustively tested
and proves the RULE. This file asks the other question: does a real sync
pass, against a real sqlite row and a real transcript file, reach the
out-of-band push - and, far more importantly, does it reach it ONLY in
the one case the rule authorises. A rule that is right and a seam that
ignores it look identical from the unit tests, which is a mistake this
project has shipped before.

THE SPAWN IS COUNTED, NEVER RUN. ``spawn_oob_rename`` is replaced by a
recorder, so nothing here starts a process, resolves the real claude
binary or touches the developer's corpus. The count is the assertion:
zero on every refusal, exactly one on the authorised push, and exactly
``MAX_PUSH_ATTEMPTS`` over a session that never reconciles. A test that
only checked a returned verdict would pass just as happily against a seam
that spawned on every pass.

NOTHING HERE TOUCHES THE DEVELOPER'S DATABASE, STATE DIRECTORY OR TMUX.
Every test builds its own sessions table and its own state directory, and
the feature is OFF by default under ``CLOUDE_TEST_MODE`` - which is
itself one of the tests below, because a suite that silently spawned
renames against live conversations is the failure this guard exists for.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_rra_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_rra_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
import json

import pytest

from src.core import claude_rename as rename_mod
from src.core import claude_rename_retry_apply as seam
from src.core import claude_rename_retry_store as store
from src.core import claude_title_sync_apply as apply_mod
from src.core import server_status as status_mod
from src.core.claude_rename_retry import (
    MAX_PUSH_ATTEMPTS,
    MIN_ATTEMPT_INTERVAL_SECONDS,
    RETRY_AGREED,
    RETRY_EXHAUSTED,
    RETRY_PUSH,
    RETRY_SUPERSEDED,
    RETRY_UNORDERED,
)
from src.core.claude_title_sync_apply import sync_claude_title
from src.core.sessions.hook_token_authority import HookTokenAuthority
from src.core.sessions.registry import SessionRegistry

UUID = "560a0e05-b778-4784-ae2c-4edd46da22d0"
TMUX_NAME = "cloude_Hirschfeld-2"
OLD = "Agent - Hirschfeld (Helen)"
NEW = "Agent - Hirschfeld (Rustdesk)"
CLAUDE_PATH = "/nonexistent/claude-for-tests"


class _FakeSession:
    """The two attributes the sync seam reads off a live session.

    Inputs: tmux_session (str). working_dir (str | None).
    Output: n/a (data holder).
    """

    def __init__(self, tmux_session, working_dir=None):
        self.tmux_session = tmux_session
        self.working_dir = working_dir


class _NoCloseConn:
    """A sqlite connection whose close() is a no-op.

    Description: the seam closes what it is handed, which would break a
      multi-pass test. Everything except close reaches the real driver,
      so a statement naming a missing column still fails as it would
      live.
    Inputs: inner (sqlite3.Connection).
    Output: n/a (proxy).
    Example: _NoCloseConn(sqlite3.connect(":memory:"))
    """

    def __init__(self, inner):
        self._inner = inner

    def close(self):
        """Deliberately does nothing; the fixture owns the lifetime."""
        return None

    def __getattr__(self, name):
        return getattr(self._inner, name)


class _FakeManager:
    """A SessionManager stand-in exposing only what the sync seam uses.

    Inputs: conn (sqlite3.Connection). state_dir (Path).
    Output: n/a.
    """

    def __init__(self, conn, state_dir):
        self._conn = conn
        self._registry = SessionRegistry(log_cap=lambda: 1000)
        self._registry.sessions["ses_test"] = _FakeSession(TMUX_NAME, "/tmp/p")
        self.hook_tokens = HookTokenAuthority(lambda: Path(state_dir))

    def _tmux_socket_name(self):
        """The socket the sanctioned row lookup constrains on.

        Inputs: none.
        Output: str.
        """
        return "cloude"

    def _writable_datastore_connection(self):
        """Hand back the test's connection.

        Inputs: none.
        Output: sqlite3.Connection.
        """
        return self._conn


@pytest.fixture
def db(tmp_path):
    """A sessions table holding the columns this pass reads and writes.

    Inputs: tmp_path (pathlib.Path).
    Output: sqlite3.Connection.
    """
    conn = sqlite3.connect(str(tmp_path / "sessions.db"))
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE sessions ("
        "id INTEGER PRIMARY KEY, tmux_socket TEXT, tmux_name TEXT, "
        "tmux_created_epoch INTEGER, claude_session_uuid TEXT, title TEXT, "
        "claude_title TEXT, working_dir TEXT, parent_session_id INTEGER, "
        "agent_type TEXT, agent_family TEXT, agent_family_source TEXT)"
    )
    conn.commit()
    return _NoCloseConn(conn)


@pytest.fixture
def spawns(tmp_path, monkeypatch):
    """Enable the retry, stub every outward call, and count the spawns.

    Description: the three things the push would otherwise reach are the
      version probe, the binary resolver and the subprocess, and all
      three are replaced. What is left under test is the seam's own
      decision to call them at all.
    Inputs: tmp_path (pathlib.Path). monkeypatch.
    Output: list - one argv per spawn, in order.
    """
    store.reset_cache()
    monkeypatch.setenv(seam.ENABLE_ENV, "1")
    # THE LEDGER IS POINTED AT THIS TEST'S OWN DIRECTORY, not at the
    # suite's shared throwaway state dir. The ledger key is the
    # conversation uuid plus the row id and every test here builds the
    # same pair, so a shared file would let one test's spent budget
    # decide another test's verdict.
    monkeypatch.setattr(store, "resolve_state_dir", lambda: tmp_path / "state")
    monkeypatch.setattr(rename_mod, "detect_claude_version", lambda: (2, 1, 263))
    monkeypatch.setattr(
        status_mod,
        "collect_claude_cli",
        lambda: {"available": True, "path": CLAUDE_PATH, "version": "2.1.263"},
    )
    recorded: list = []

    def _record(argv, *, session_id):
        """Stand in for the real spawn, recording the argv.

        Inputs: argv (list[str]). session_id (str).
        Output: bool.
        """
        recorded.append(argv)
        return True

    monkeypatch.setattr(rename_mod, "spawn_oob_rename", _record)
    yield recorded
    store.reset_cache()


@pytest.fixture
def transcript(tmp_path, monkeypatch):
    """A transcript the sync will resolve to, with the path cache bypassed.

    Inputs: tmp_path (pathlib.Path). monkeypatch.
    Output: callable - writes custom-title records and returns the path.
    """
    apply_mod._TRANSCRIPT_PATHS.clear()
    target = tmp_path / "conversation.jsonl"

    def _write(*titles):
        target.write_text(
            "\n".join(
                json.dumps(
                    {"type": "custom-title", "customTitle": t, "sessionId": UUID}
                )
                for t in titles
            )
            + "\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(
            apply_mod, "_transcript_path_for", lambda uuid, working_dir: str(target)
        )
        return str(target)

    yield _write
    apply_mod._TRANSCRIPT_PATHS.clear()


def _row(conn, *, title, claude_title):
    """Insert one instance row and return its id.

    Inputs: conn (sqlite3.Connection). title (str | None). claude_title
      (str | None).
    Output: int - the row id.
    Example: _row(conn, title='A', claude_title='A')
    """
    cur = conn.execute(
        "INSERT INTO sessions (tmux_socket, tmux_name, tmux_created_epoch, "
        "claude_session_uuid, title, claude_title, working_dir, agent_family) "
        "VALUES ('cloude', ?, 1788878841, ?, ?, ?, '/tmp/p', 'claude')",
        (TMUX_NAME, UUID, title, claude_title),
    )
    conn.commit()
    return cur.lastrowid


# ---------------------------------------------------------------------
# The guard that protects this suite.
# ---------------------------------------------------------------------


def test_the_retry_is_off_by_default_under_test_mode(db, transcript, tmp_path):
    """A pytest run must never spawn a rename against a live conversation.

    Without this the very fixtures above - a row whose two names disagree
    - would have reached the real ``claude -p --resume`` against the
    developer's own corpus on every unrelated test that happened to build
    one.
    """
    store.reset_cache()
    assert os.environ.get("CLOUDE_TEST_MODE")
    assert seam.retry_enabled() is False

    _row(db, title=NEW, claude_title=OLD)
    transcript(OLD)
    result = sync_claude_title(_FakeManager(db, tmp_path), "ses_test")
    assert result.retry.verdict == seam.RETRY_DISABLED


# ---------------------------------------------------------------------
# NEGATIVE CONTROLS: the spawn count must be zero.
# ---------------------------------------------------------------------


def test_a_cold_divergent_row_is_never_pushed(db, transcript, spawns, tmp_path):
    """THE LOAD-BEARING NEGATIVE CONTROL, and the shape of the live rows.

    This is exactly the state the owner's database is in: the two names
    disagree and no agreement was ever witnessed, because the ledger did
    not exist when they diverged. The retry must refuse, forever, rather
    than push a label it cannot show to be the newer one.
    """
    _row(db, title=NEW, claude_title=OLD)
    transcript(OLD)
    manager = _FakeManager(db, tmp_path)

    for _ in range(4):
        result = sync_claude_title(manager, "ses_test")
        assert result.retry.verdict == RETRY_UNORDERED
    assert spawns == []


def test_a_tui_rename_is_never_overwritten_by_a_pending_push(
    db, transcript, spawns, tmp_path
):
    """A newer name from the other side wins, and the push dies quietly.

    The history is built rather than asserted: both sides agree on OLD,
    so the frame is witnessed; the browser then writes NEW; and before
    the retry can run, the transcript carries a THIRD name typed in the
    TUI. The sync applies that name and the retry must stand down.
    """
    row_id = _row(db, title=OLD, claude_title=OLD)
    transcript(OLD)
    manager = _FakeManager(db, tmp_path)
    assert sync_claude_title(manager, "ses_test").retry.verdict == RETRY_AGREED

    db.execute("UPDATE sessions SET title = ? WHERE id = ?", (NEW, row_id))
    db.commit()
    transcript(OLD, "typed in the pane")

    result = sync_claude_title(manager, "ses_test")
    assert result.retry.verdict == RETRY_SUPERSEDED
    assert spawns == []
    assert db.execute(
        "SELECT title, claude_title FROM sessions WHERE id = ?", (row_id,)
    ).fetchone()[:] == ("typed in the pane", "typed in the pane")


def test_a_healthy_session_spawns_nothing_at_all(db, transcript, spawns, tmp_path):
    """The steady state is free. A retry that always fires is worse than none."""
    _row(db, title=OLD, claude_title=OLD)
    transcript(OLD)
    manager = _FakeManager(db, tmp_path)

    for _ in range(5):
        assert sync_claude_title(manager, "ses_test").retry.verdict == RETRY_AGREED
    assert spawns == []


# ---------------------------------------------------------------------
# THE ONE CASE THAT SPAWNS.
# ---------------------------------------------------------------------


def test_a_failed_browser_push_is_retried_once_the_frame_exists(
    db, transcript, spawns, tmp_path
):
    """The whole feature, end to end, through a real row and a real file.

    Pass one witnesses the agreement. The browser then renames and its
    own push fails, which is modelled exactly as it happens live: the
    ``title`` column moves and the transcript does not. Pass two sees
    claude still holding the agreed name, orders the browser's label as
    the newer one, and spawns the out-of-band rename with the argv
    ``claude_rename`` builds.
    """
    row_id = _row(db, title=OLD, claude_title=OLD)
    transcript(OLD)
    manager = _FakeManager(db, tmp_path)
    sync_claude_title(manager, "ses_test")

    db.execute("UPDATE sessions SET title = ? WHERE id = ?", (NEW, row_id))
    db.commit()

    result = sync_claude_title(manager, "ses_test")
    assert result.retry.verdict == RETRY_PUSH
    assert spawns == [[CLAUDE_PATH, "-p", "--resume", UUID, f"/rename {NEW}"]]


def test_the_retry_stops_after_the_bound_on_a_session_it_can_never_reach(
    db, transcript, spawns, tmp_path, monkeypatch
):
    """THE BOUND, counted in spawns rather than in verdicts.

    The push is authorised on every pass and never reconciles, which is
    what a deleted transcript or a claude that will not answer looks like
    from here. Time is advanced past the interval floor each pass so the
    floor is not what stops it. Exactly ``MAX_PUSH_ATTEMPTS`` processes
    are started, ever, and every pass afterwards answers a NAMED terminal
    state.
    """
    row_id = _row(db, title=OLD, claude_title=OLD)
    transcript(OLD)
    manager = _FakeManager(db, tmp_path)
    sync_claude_title(manager, "ses_test")

    db.execute("UPDATE sessions SET title = ? WHERE id = ?", (NEW, row_id))
    db.commit()

    clock = {"now": 1_000.0}
    monkeypatch.setattr(seam.time, "time", lambda: clock["now"])
    verdicts = []
    for _ in range(MAX_PUSH_ATTEMPTS + 6):
        verdicts.append(sync_claude_title(manager, "ses_test").retry.verdict)
        clock["now"] += MIN_ATTEMPT_INTERVAL_SECONDS * 2

    assert len(spawns) == MAX_PUSH_ATTEMPTS
    assert verdicts[:MAX_PUSH_ATTEMPTS] == [RETRY_PUSH] * MAX_PUSH_ATTEMPTS
    assert set(verdicts[MAX_PUSH_ATTEMPTS:]) == {RETRY_EXHAUSTED}


def test_the_budget_survives_a_restart_of_the_process(
    db, transcript, spawns, tmp_path, monkeypatch
):
    """An in-memory counter would refill on restart and be no bound at all.

    The ledger cache is dropped between passes, which is what a server
    restart looks like to this module, and the budget still runs out
    after ``MAX_PUSH_ATTEMPTS`` spawns rather than after that many per
    restart.
    """
    row_id = _row(db, title=OLD, claude_title=OLD)
    transcript(OLD)
    manager = _FakeManager(db, tmp_path)
    sync_claude_title(manager, "ses_test")

    db.execute("UPDATE sessions SET title = ? WHERE id = ?", (NEW, row_id))
    db.commit()

    clock = {"now": 1_000.0}
    monkeypatch.setattr(seam.time, "time", lambda: clock["now"])
    for _ in range(MAX_PUSH_ATTEMPTS + 4):
        sync_claude_title(manager, "ses_test")
        clock["now"] += MIN_ATTEMPT_INTERVAL_SECONDS * 2
        store.reset_cache()

    assert len(spawns) == MAX_PUSH_ATTEMPTS


def test_a_push_that_lands_settles_the_row_and_stops_retrying(
    db, transcript, spawns, tmp_path
):
    """Success is a transcript carrying the new name, and it ends the retry.

    The push writes a ``custom-title`` record of its own, so a landed
    push arrives back through the ordinary sync as a changed name. Both
    columns then agree, the frame moves to the new name with a fresh
    budget, and nothing is spawned again.
    """
    row_id = _row(db, title=OLD, claude_title=OLD)
    transcript(OLD)
    manager = _FakeManager(db, tmp_path)
    sync_claude_title(manager, "ses_test")

    db.execute("UPDATE sessions SET title = ? WHERE id = ?", (NEW, row_id))
    db.commit()
    assert sync_claude_title(manager, "ses_test").retry.verdict == RETRY_PUSH

    transcript(OLD, NEW)
    assert sync_claude_title(manager, "ses_test").retry.verdict == RETRY_SUPERSEDED
    for _ in range(3):
        assert sync_claude_title(manager, "ses_test").retry.verdict == RETRY_AGREED
    assert len(spawns) == 1
    assert db.execute(
        "SELECT title, claude_title FROM sessions WHERE id = ?", (row_id,)
    ).fetchone()[:] == (NEW, NEW)


def test_a_non_claude_agent_is_never_sent_a_rename(
    db, transcript, spawns, tmp_path
):
    """``/rename`` is a claude command, and a codex pane must not receive it.

    The ladder can authorise a push on the strength of the names alone;
    it is ``decide_push`` that knows what claude accepts, and this proves
    the seam still asks it.
    """
    row_id = _row(db, title=OLD, claude_title=OLD)
    db.execute("UPDATE sessions SET agent_family = 'codex' WHERE id = ?", (row_id,))
    db.commit()
    transcript(OLD)
    manager = _FakeManager(db, tmp_path)
    sync_claude_title(manager, "ses_test")

    db.execute("UPDATE sessions SET title = ? WHERE id = ?", (NEW, row_id))
    db.commit()

    result = sync_claude_title(manager, "ses_test")
    assert result.retry.verdict == seam.RETRY_PUSH_REFUSED
    assert spawns == []
