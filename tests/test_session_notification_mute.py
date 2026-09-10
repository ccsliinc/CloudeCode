"""The durable per-session notification mute, end to end.

"mute notifications" on the session action menu is a standing instruction
about ONE session. It has to survive a server restart and a restart of the
session itself, it has to stop web alerts AND phone pushes, and it has to
do all of that WITHOUT quietly answering anything on the user's behalf.

The properties this file exists to hold down, each of which was a way to
get it wrong:

1. IT IS ON THE ROW, so it survives. A mute held in memory would be gone
   at the next restart, and a mute keyed on a pane pid would be gone at
   the next ``respawn-pane -k``. The row survives both.
2. IT SUPPRESSES BOTH CHANNELS. A gate at the toast raise site alone
   would leave the push dispatcher sending; a gate at the dispatcher
   alone would leave the browser painting cards.
3. IT ACKNOWLEDGES NOTHING - THE NEGATIVE CONTROL. A muted
   ``PermissionRequest`` must still leave the session BLOCKED and
   reporting ``question``. An implementation that "helpfully" cleared it
   would pass every suppression test above and strand claude mid-turn
   behind a yes/no nobody was ever shown.
4. UNMUTING DOES NOT REPLAY. What was suppressed was never held.
5. NEW SESSIONS AND FORKS START UNMUTED. A mute is a decision about one
   session, not a property a child inherits.
6. AN OLD ALERT CANNOT ESCAPE A MUTE/UNMUTE CYCLE. Queue entries carry
   the policy generation they were raised under and are refused when it
   is no longer current - in EITHER direction.
7. A FAILED POLICY READ NEVER ANSWERS "NOT MUTED". This is deliberately
   the opposite posture from the sub-agent toast gate beside it, and the
   reason is asymmetric cost: a spurious alert is an annoyance, an
   unwanted push to a phone is a promise broken.
8. A REUSED TMUX NAME CANNOT BE TARGETED. A row action fired from a list
   painted before the session was replaced is refused, not applied to
   whatever holds the name now.

Run with:
    venv/bin/python3 -m pytest tests/test_session_notification_mute.py -v
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

# ---- minimal env bootstrap so `src.config` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_mute_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_mute_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
import sys

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from fastapi import FastAPI
from fastapi.testclient import TestClient

import src.api.routes as routes_mod
from src.api.auth import require_auth
from src.core import session_store
from src.core.db_steps import run_chain
from src.core.notifications.events import EventType, NotificationEvent
from src.core.notifications.router import NotificationRouter
from src.core.session_manager import SessionManager
from src.core.session_notification_policy import (
    DISPATCH_ALLOWED,
    DISPATCH_ALLOWED_UNSTAMPED,
    DISPATCH_REFUSED_MUTED,
    DISPATCH_REFUSED_POLICY_UNKNOWN,
    DISPATCH_REFUSED_STALE_GENERATION,
    POLICY_MUTED,
    POLICY_UNKNOWN,
    POLICY_UNMUTED,
    NotificationPolicyStore,
    hydrate_from_datastore,
)
from src.core.session_status import STATUS_RUNNING
from src.models import Session, SessionStatus

TMUX_SOCKET = "cloude"
TMUX_NAME = "cloude_mute_proj"
TMUX_EPOCH = 1_700_000_000

#: A real captured trust-prompt tail, borrowed verbatim from
#: tests/test_session_startup_gate.py so both files feed the detector the
#: same bytes claude actually printed. A paraphrase would test the
#: paraphrase.
TRUST_PROMPT_TAIL = """
 Accessing workspace:

 /private/tmp/cc-probe/workdir

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 well-known open source project, or work from your team). If not, take a moment to review what's in
 this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 > No, exit
   Yes, I trust this folder
"""


# =========================================================================== #
# Fixtures and builders                                                       #
# =========================================================================== #


def _make_db(path: Path) -> sqlite3.Connection:
    """A real, fully migrated datastore on disk.

    Description: a REAL sqlite file rather than a double, because the
      whole claim under test is that the mute is written somewhere that
      outlives the process. A fake store could not fail that way.
    Inputs: path (Path) - where to put the file.
    Output: sqlite3.Connection - open, row_factory set, at the current
      schema version.
    Example: conn = _make_db(tmp_path / 'cloude.db')
    """
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    with conn:
        run_chain(conn, 0, __import__(
            "src.core.db_models", fromlist=["CURRENT_SCHEMA_VERSION"]
        ).CURRENT_SCHEMA_VERSION)
    return conn


def _insert_session(
    conn: sqlite3.Connection,
    *,
    session_uuid: str,
    tmux_name: str = TMUX_NAME,
    epoch: int = TMUX_EPOCH,
    parent_session_id=None,
) -> int:
    """Insert one minimal sessions row and return its integer id.

    Inputs: conn. session_uuid (str). tmux_name (str). epoch (int).
      parent_session_id (int | None) - set to make the row a fork child.
    Output: int - ``sessions.id``.
    Example: _insert_session(conn, session_uuid='u1')
    """
    cur = conn.execute(
        "INSERT INTO sessions (session_uuid, origin, lifecycle, "
        "project_attribution, tmux_socket, tmux_name, tmux_created_epoch, "
        "parent_session_id, created_at, updated_at) "
        "VALUES (?, 'created', 'running', 'none', ?, ?, ?, ?, ?, ?)",
        (
            session_uuid,
            TMUX_SOCKET,
            tmux_name,
            epoch,
            parent_session_id,
            "2026-09-09T00:00:00Z",
            "2026-09-09T00:00:00Z",
        ),
    )
    conn.commit()
    return int(cur.lastrowid)


class _StubSettings:
    """Just enough of ``Settings`` for SessionManager.__init__."""

    def __init__(self, pin_path: Path, log_dir: Path, port: int = 5001):
        self._pin_path = pin_path
        self._log_dir = log_dir
        self.port = port

    def get_pinned_themes_path(self) -> Path:
        return self._pin_path

    def get_unread_state_path(self) -> Path:
        return self._pin_path.parent / "unread_state.json"

    @property
    def log_directory(self) -> str:
        return str(self._log_dir)

    def get_session_metadata_path(self) -> Path:
        return self._log_dir / "session_metadata.json"


class _FakeBackend:
    """Bare enough of a SessionBackend for tmux_session lookups.

    ``socket_name`` is present because the startup gate refuses to
    capture a pane tail without one - a backend that cannot name its
    socket cannot be probed, and the gate answers ``unknown`` rather than
    guessing.
    """

    def __init__(self, tmux_session: str, socket_name: str = TMUX_SOCKET):
        self.tmux_session = tmux_session
        self.socket_name = socket_name

    def is_alive(self) -> bool:
        return True


class _RecordingRouter:
    """A notification router that records instead of sending.

    Description: stands in for the real ``NotificationRouter`` at the
      ``record_toast`` seam so a test can assert what was HANDED to the
      push subsystem. The real router's own gate is exercised separately
      against the real class - see the dispatcher tests below.
    """

    def __init__(self):
        """Inputs: none. Output: None."""
        self.emitted: list = []

    def emit(self, event) -> None:
        """Record one event. Inputs: event. Output: None."""
        self.emitted.append(event)


def _build_hook_app(monkeypatch, tmp_path, *, store=None, router=None):
    """A SessionManager with one live session, wired to a test app.

    Mirrors ``tests/test_hook_toast_subagent_suppression.py`` so both
    files describe the hook endpoint the same way.

    Inputs: monkeypatch, tmp_path (pytest fixtures). store
      (NotificationPolicyStore | None) - attached when given. router -
      attached when given.
    Output: (FastAPI, SessionManager).
    """
    stub = _StubSettings(
        pin_path=tmp_path / "pinned_themes.json",
        log_dir=tmp_path / "logs",
    )
    (tmp_path / "logs").mkdir(exist_ok=True)
    monkeypatch.setattr("src.core.session_manager.settings", stub)
    mgr = SessionManager()

    work = tmp_path / "mute_proj"
    work.mkdir(exist_ok=True)
    mgr.sessions["ses_mute"] = Session(
        id="ses_mute",
        pty_pid=None,
        working_dir=str(work),
        status=SessionStatus.RUNNING,
        tmux_session=TMUX_NAME,
    )
    mgr.backends["ses_mute"] = _FakeBackend(TMUX_NAME)
    mgr._subscribers.setdefault("ses_mute", [])
    mgr._instance_epochs["ses_mute"] = TMUX_EPOCH
    mgr._mint_hook_token("ses_mute")
    if store is not None:
        mgr.attach_notification_policy_store(store)
    if router is not None:
        mgr.attach_notification_router(router)

    app = FastAPI()
    app.state.session_manager = mgr
    app.include_router(routes_mod.router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: True
    return app, mgr


def _post_event(app, mgr, event: str):
    """POST one hook event as the loopback hook subprocess would.

    Inputs: app (FastAPI). mgr (SessionManager). event (str) - hook kind.
    Output: (Response, AsyncMock) - the response and the websocket
      broadcast mock, so a caller can prove a suppressed alert did
      neither.
    """
    client = TestClient(app, client=("127.0.0.1", 12345))
    with patch.object(
        routes_mod.connection_manager,
        "broadcast_to_session",
        new=AsyncMock(return_value=None),
    ) as mock_bcast:
        resp = client.post(
            "/api/v1/hooks/claude-event",
            headers={
                "X-Cloudecode-Session": "ses_mute",
                "X-Cloudecode-Token": mgr.get_hook_token("ses_mute"),
                "X-Cloudecode-Event": event,
                "Content-Type": "application/json",
            },
            json={},
        )
    return resp, mock_bcast


def _muted_store(session_uuid: str = "u1", generation: int = 1):
    """A hydrated store holding one MUTED session on the test instance.

    Inputs: session_uuid (str). generation (int).
    Output: NotificationPolicyStore.
    """
    store = NotificationPolicyStore()
    store.hydrate(
        [
            {
                "session_uuid": session_uuid,
                "tmux_socket": TMUX_SOCKET,
                "tmux_name": TMUX_NAME,
                "tmux_created_epoch": TMUX_EPOCH,
                "muted": True,
                "generation": generation,
            }
        ]
    )
    return store


def _unmuted_store(session_uuid: str = "u1", generation: int = 0):
    """A hydrated store holding one UNMUTED session on the test instance.

    Inputs: session_uuid (str). generation (int).
    Output: NotificationPolicyStore.
    """
    store = NotificationPolicyStore()
    store.hydrate(
        [
            {
                "session_uuid": session_uuid,
                "tmux_socket": TMUX_SOCKET,
                "tmux_name": TMUX_NAME,
                "tmux_created_epoch": TMUX_EPOCH,
                "muted": False,
                "generation": generation,
            }
        ]
    )
    return store


# =========================================================================== #
# 1. It is on the row, and the row outlives the process                       #
# =========================================================================== #


def test_the_mute_is_written_to_the_row_and_survives_reopening_the_file(tmp_path):
    """PERSISTENCE ACROSS A RESTART, measured by closing the database.

    Nothing in-process carries the answer across: the connection is
    dropped and a NEW one is opened against the same file, which is
    exactly what a server restart does.
    """
    db = tmp_path / "cloude.db"
    conn = _make_db(db)
    _insert_session(conn, session_uuid="u1")

    committed = session_store.set_notification_mute(conn, "u1", muted=True)
    assert committed["muted"] is True
    assert committed["changed"] is True
    conn.close()

    reopened = sqlite3.connect(str(db))
    reopened.row_factory = sqlite3.Row
    try:
        assert session_store.get_notification_policy(reopened, "u1") == {
            "muted": True,
            "generation": 1,
        }
    finally:
        reopened.close()


def test_the_mute_survives_a_same_record_session_restart(tmp_path):
    """A restart that KEEPS the row keeps the mute, by construction.

    ``respawn-pane -k`` replaces the pane's process and keeps the tmux
    session, its name and (measured, tmux 3.7c) its creation epoch - so
    the same row is still the session's row. Every other column the
    restart path touches is moved here to prove none of them disturbs
    the policy.
    """
    conn = _make_db(tmp_path / "cloude.db")
    _insert_session(conn, session_uuid="u1")
    session_store.set_notification_mute(conn, "u1", muted=True)

    # What a live restart writes: a new agent_type on the same row.
    conn.execute(
        "UPDATE sessions SET agent_type = 'claude-chrome' WHERE session_uuid = ?",
        ("u1",),
    )
    conn.commit()

    assert session_store.get_notification_policy(conn, "u1")["muted"] is True
    conn.close()


def test_a_pre_v26_database_cannot_report_a_mute_and_says_so(tmp_path):
    """The columns are absent, so the honest answer is "no such record".

    Not "unmuted" from a read that never happened, and not a crash out of
    a listing route: the caller gets the same not-found it would get for
    an unknown uuid, which routes to a 404 it can act on.
    """
    db = tmp_path / "old.db"
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    with conn:
        run_chain(conn, 0, 25)
    _insert_session(conn, session_uuid="u1")

    assert session_store.notification_policy_rows(conn) == []
    with pytest.raises(session_store.SessionNotFoundError):
        session_store.get_notification_policy(conn, "u1")
    with pytest.raises(session_store.SessionNotFoundError):
        session_store.set_notification_mute(conn, "u1", muted=True)
    conn.close()


# =========================================================================== #
# 2. The generation, and what it is for                                       #
# =========================================================================== #


def test_the_generation_steps_on_mute_and_on_unmute_alike(tmp_path):
    """It dates the POLICY, not the muting. Both directions are changes."""
    conn = _make_db(tmp_path / "cloude.db")
    _insert_session(conn, session_uuid="u1")

    assert session_store.set_notification_mute(conn, "u1", muted=True)[
        "generation"
    ] == 1
    assert session_store.set_notification_mute(conn, "u1", muted=False)[
        "generation"
    ] == 2
    assert session_store.set_notification_mute(conn, "u1", muted=True)[
        "generation"
    ] == 3
    conn.close()


def test_a_no_op_request_writes_nothing_and_does_not_step_the_generation(tmp_path):
    """Idempotent, and idempotent QUIETLY.

    Stepping on a repeat would invalidate every queued notification each
    time a client re-sent the state it already had, which is a way to
    lose alerts nobody asked to lose.
    """
    conn = _make_db(tmp_path / "cloude.db")
    _insert_session(conn, session_uuid="u1")
    session_store.set_notification_mute(conn, "u1", muted=True)

    again = session_store.set_notification_mute(conn, "u1", muted=True)
    assert again["changed"] is False
    assert again["generation"] == 1
    conn.close()


def test_an_alert_queued_before_a_mute_cannot_escape_after_it():
    """THE ESCAPE THIS FILE IS NAMED FOR, in the mute direction.

    The alert is raised while the session is noisy, sits in the queue,
    and the user mutes before it drains. Judged at the moment of sending,
    it is refused.
    """
    store = _unmuted_store(generation=0)
    ok, reason = store.allows_dispatch("u1", 0)
    assert (ok, reason) == (True, DISPATCH_ALLOWED)

    store.apply("u1", muted=True, generation=1)
    ok, reason = store.allows_dispatch("u1", 0)
    assert ok is False
    # Reported as MUTED rather than stale: the session is muted now, which
    # is the more actionable of the two true statements.
    assert reason == DISPATCH_REFUSED_MUTED


def test_an_alert_queued_before_a_mute_unmute_cycle_is_still_refused():
    """THE ESCAPE THIS FILE IS NAMED FOR, in the round-trip direction.

    This is the one a mute-only gate misses. The session ends the cycle
    UNMUTED, so a gate that only asked "is it muted now" would release
    the backlog it had been sitting on - which is exactly "unmute resumes
    future alerts without replaying a backlog" being violated. The
    generation is what refuses it: two policy changes happened while the
    entry waited.
    """
    store = _unmuted_store(generation=0)
    store.apply("u1", muted=True, generation=1)
    store.apply("u1", muted=False, generation=2)

    ok, reason = store.allows_dispatch("u1", 0)
    assert ok is False
    assert reason == DISPATCH_REFUSED_STALE_GENERATION

    # And an alert raised AFTER the unmute goes out normally. Resuming is
    # the other half of the claim and a gate that refused everything
    # would pass the assertion above for the wrong reason.
    assert store.allows_dispatch("u1", 2) == (True, DISPATCH_ALLOWED)


def test_an_unstamped_event_is_always_sent():
    """A producer with no session identity has no policy to violate.

    Dropping these would retire a notification channel rather than mute a
    session, so the default has to be permissive - and it has to be
    DISTINGUISHABLE from a policy that could not be read, which is the
    next test.
    """
    store = _muted_store()
    assert store.allows_dispatch(None, None) == (
        True,
        DISPATCH_ALLOWED_UNSTAMPED,
    )


# =========================================================================== #
# 3. A failed read never answers "not muted"                                  #
# =========================================================================== #


def test_an_unhydrated_store_answers_unknown_for_everything():
    """NOT ``unmuted``. Nothing has been read, so nothing is known."""
    store = NotificationPolicyStore()
    assert store.hydrated is False
    assert store.needs_hydration() is True
    assert store.for_uuid("u1").verdict == POLICY_UNKNOWN
    assert store.for_instance(TMUX_NAME, TMUX_EPOCH).verdict == POLICY_UNKNOWN


def test_unknown_suppresses_but_does_not_paint_as_muted():
    """Two questions, two answers, and one boolean cannot carry both.

    ``suppresses`` asks "may an alert go out"; ``muted`` asks "does the
    ROW say the user muted this". A UI that painted "muted" over an
    unreadable database would be claiming a setting is in force that
    nobody has looked at.
    """
    store = NotificationPolicyStore()
    verdict = store.for_uuid("u1")
    assert verdict.suppresses is True
    assert verdict.muted is False


def test_a_failed_hydration_leaves_the_store_unhydrated(tmp_path):
    """A file that exists and cannot be read is NOT an empty answer.

    THE NEGATIVE CONTROL FOR THE WHOLE MODULE. An implementation that
    caught the error and hydrated with ``[]`` would pass every other test
    in this file and silently unmute every muted session the first time
    the database hiccupped.
    """
    db = tmp_path / "corrupt.db"
    db.write_bytes(b"this is not a sqlite database at all, not even close")

    store = NotificationPolicyStore()
    assert hydrate_from_datastore(store, db) is False
    assert store.hydrated is False
    assert store.for_uuid("u1").verdict == POLICY_UNKNOWN


def test_a_missing_database_file_hydrates_empty_and_is_a_measurement(tmp_path):
    """No rows means nothing can be muted, so this is an ANSWER.

    A fresh install must not spend its first boot suppressing every
    notification it has, which is what treating an absent file as a read
    failure would do.
    """
    store = NotificationPolicyStore()
    assert hydrate_from_datastore(store, tmp_path / "nothing-here.db") is True
    assert store.hydrated is True
    assert store.for_uuid("u1").verdict == POLICY_UNMUTED


def test_a_later_failed_read_cannot_downgrade_what_is_already_known(tmp_path):
    """A re-read that FAILS leaves every known mute exactly as it was.

    The rule is "a failed preference read must not default a muted
    session to unmuted", and the way to break it after the first
    hydration succeeded is to wipe the index on a later failure - which
    would unmute every session at once, silently, while the store went on
    reporting itself hydrated.
    """
    corrupt = tmp_path / "corrupt.db"
    corrupt.write_bytes(b"this is not a sqlite database")

    store = _muted_store()
    assert hydrate_from_datastore(store, corrupt) is False
    assert store.hydrated is True
    assert store.for_uuid("u1").verdict == POLICY_MUTED
    assert store.for_instance(TMUX_NAME, TMUX_EPOCH).verdict == POLICY_MUTED


def test_a_dispatcher_refuses_an_event_stamped_unknown():
    """The producer HAD a session and could not read its policy.

    That is a different fact from an event carrying no session at all,
    and only one of the two may be read as "send it".
    """
    router = NotificationRouter(_RouterConfig(), loop=None)
    event = NotificationEvent(
        kind=EventType.CLAUDE_STOP,
        session_slug="ses_mute",
        timestamp=0.0,
        policy_verdict=POLICY_UNKNOWN,
    )
    assert router._policy_allows(event) == (
        False,
        DISPATCH_REFUSED_POLICY_UNKNOWN,
    )


class _RouterConfig:
    """A notifications config with every channel configured.

    Description: the router short-circuits ``emit`` when no channel is
      set up, so a test that wants to observe the POLICY gate has to get
      past that first.
    """

    enabled = True
    ntfy_topic = "test-topic"
    ntfy_base_url = "https://example.invalid"
    slack_webhook_url = ""
    pushover_token = ""
    pushover_user_key = ""
    public_base_url = ""
    rate_limit_global_cap = 1000
    rate_limit_window_seconds = 60.0
    rate_limit_per_kind_cooldown_seconds = 0.0


# =========================================================================== #
# 4. The dispatcher gate, on the real router                                  #
# =========================================================================== #


def test_the_router_drops_a_muted_event_at_the_door():
    """Refused at ``emit`` so a muted session cannot evict other alerts.

    The queue is bounded and drops the OLDEST on overflow, so a muted
    session left free to enqueue would push out notifications a different
    session's user does want.
    """
    router = NotificationRouter(_RouterConfig(), loop=None)
    router.attach_policy_store(_muted_store())
    router.emit(
        NotificationEvent(
            kind=EventType.CLAUDE_STOP,
            session_slug="ses_mute",
            timestamp=0.0,
            policy_key="u1",
            policy_generation=1,
            policy_verdict=POLICY_MUTED,
        )
    )
    assert router._queue.qsize() == 0


def test_the_router_still_enqueues_an_unmuted_event():
    """The positive control. A gate that refused everything would pass
    the test above and deliver nothing, ever."""
    router = NotificationRouter(_RouterConfig(), loop=None)
    router.attach_policy_store(_unmuted_store())
    router.emit(
        NotificationEvent(
            kind=EventType.CLAUDE_STOP,
            session_slug="ses_mute",
            timestamp=0.0,
            policy_key="u1",
            policy_generation=0,
            policy_verdict=POLICY_UNMUTED,
        )
    )
    assert router._queue.qsize() == 1


def test_a_router_with_no_policy_store_behaves_exactly_as_before():
    """A build with no mute wired in must not go quiet."""
    router = NotificationRouter(_RouterConfig(), loop=None)
    router.emit(
        NotificationEvent(
            kind=EventType.CLAUDE_STOP,
            session_slug="ses_mute",
            timestamp=0.0,
        )
    )
    assert router._queue.qsize() == 1


# =========================================================================== #
# 5. The hook raise site: both channels, and what is NOT touched              #
# =========================================================================== #


@pytest.mark.parametrize(
    "event", ["Stop", "Notification", "PermissionRequest"]
)
def test_a_muted_session_raises_no_web_alert_for_any_toast_kind(
    monkeypatch, tmp_path, event
):
    """No toast recorded, nothing broadcast, for EVERY toast kind.

    Including ``PermissionRequest``: the sub-agent gate exempts it
    because a blocked session genuinely does want the user, but a mute is
    the user answering that in advance for this session. Exempting a kind
    from the control would mean it does not do what its label says.
    """
    app, mgr = _build_hook_app(
        monkeypatch, tmp_path, store=_muted_store(), router=_RecordingRouter()
    )
    resp, mock_bcast = _post_event(app, mgr, event)

    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["ok"] is True
    assert "toast_id" not in payload
    assert payload["toast_suppressed"] == "notifications_muted"
    assert mgr._toast_inbox.get("ses_mute") == []
    mock_bcast.assert_not_called()


@pytest.mark.parametrize(
    "event", ["Stop", "Notification", "PermissionRequest"]
)
def test_a_muted_session_sends_no_external_push_either(
    monkeypatch, tmp_path, event
):
    """The push subsystem is handed NOTHING for a muted session.

    ``record_toast`` is what emits to the router, so suppressing the
    toast suppresses the push - this asserts that rather than assuming
    it, because the two would be easy to decouple by accident.
    """
    router = _RecordingRouter()
    app, mgr = _build_hook_app(
        monkeypatch, tmp_path, store=_muted_store(), router=router
    )
    _post_event(app, mgr, event)
    assert router.emitted == []


@pytest.mark.parametrize(
    "event", ["Stop", "Notification", "PermissionRequest"]
)
def test_an_unmuted_session_still_raises_and_still_pushes(
    monkeypatch, tmp_path, event
):
    """THE POSITIVE CONTROL for both channels.

    A gate that quietly grew to cover everything would pass every
    suppression assertion above and deliver nothing at all.
    """
    router = _RecordingRouter()
    app, mgr = _build_hook_app(
        monkeypatch, tmp_path, store=_unmuted_store(), router=router
    )
    resp, mock_bcast = _post_event(app, mgr, event)

    assert resp.status_code == 200, resp.text
    assert "toast_id" in resp.json()
    assert len(mgr._toast_inbox.get("ses_mute")) == 1
    mock_bcast.assert_called_once()
    assert len(router.emitted) == 1
    assert router.emitted[0].policy_key == "u1"
    assert router.emitted[0].policy_verdict == POLICY_UNMUTED


def test_an_unreadable_policy_suppresses_rather_than_notifying(
    monkeypatch, tmp_path
):
    """The opposite posture from the sub-agent gate, on purpose.

    That gate fails toward notifying because silence there would be
    bought with no evidence. Here the user has already asked for silence,
    and guessing they did not mean it sends a push to a phone that cannot
    be recalled.
    """
    app, mgr = _build_hook_app(
        monkeypatch,
        tmp_path,
        store=NotificationPolicyStore(),  # attached, never hydrated
        router=_RecordingRouter(),
    )
    resp, mock_bcast = _post_event(app, mgr, "Stop")

    assert resp.json()["toast_suppressed"] == "notifications_muted"
    assert mgr._toast_inbox.get("ses_mute") == []
    mock_bcast.assert_not_called()


def test_with_no_policy_store_attached_the_gate_does_not_run(
    monkeypatch, tmp_path
):
    """A build without the feature behaves exactly as it did before.

    This is the boundary that keeps "the policy could not be read" from
    swallowing "there is no policy in this build".
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path, router=_RecordingRouter())
    resp, mock_bcast = _post_event(app, mgr, "Stop")

    assert "toast_id" in resp.json()
    mock_bcast.assert_called_once()


# =========================================================================== #
# 6. MUTING ACKNOWLEDGES NOTHING - the negative control                       #
# =========================================================================== #


def test_a_muted_permission_request_leaves_the_session_blocked(
    monkeypatch, tmp_path
):
    """THE LOAD-BEARING TEST OF THIS FILE.

    claude has stopped mid-turn and cannot continue until a human answers
    yes or no. Muting says "do not interrupt me about it"; it does not
    say "the answer is yes" and it does not say "this is handled". An
    implementation that cleared the permission while suppressing the
    alert would pass every suppression test above and strand the agent
    behind a decision nobody was ever shown.
    """
    app, mgr = _build_hook_app(
        monkeypatch, tmp_path, store=_muted_store(), router=_RecordingRouter()
    )
    _post_event(app, mgr, "PermissionRequest")

    # The event was RECORDED even though no alert was raised.
    assert mgr._activity_tracker.hooks_seen("ses_mute") is True
    assert (
        mgr._activity_tracker.resolve("ses_mute", STATUS_RUNNING, unread=False)
        == "question"
    )


def test_a_muted_stop_still_flips_unread(monkeypatch, tmp_path):
    """Unread is a RECORD, not an interruption, so mute does not touch it.

    The user asked not to be summoned; they did not ask for the session
    to stop reporting that its turn ended. The sidebar badge is how a
    muted session is still findable.
    """
    app, mgr = _build_hook_app(
        monkeypatch, tmp_path, store=_muted_store(), router=_RecordingRouter()
    )
    _post_event(app, mgr, "Stop")
    assert mgr._is_unread(TMUX_NAME, TMUX_EPOCH) is True


def test_muting_does_not_acknowledge_a_toast_already_on_record(
    monkeypatch, tmp_path
):
    """A card raised BEFORE the mute keeps its unacknowledged state.

    Mute is a delivery preference about the future. Acking the backlog
    would destroy the user's own record of what happened, and it is
    exactly the shortcut "make the badge go away" invites.
    """
    store = _unmuted_store()
    app, mgr = _build_hook_app(
        monkeypatch, tmp_path, store=store, router=_RecordingRouter()
    )
    _post_event(app, mgr, "PermissionRequest")
    assert len(mgr._toast_inbox.get("ses_mute", unacked_only=True)) == 1

    store.apply("u1", muted=True, generation=1)

    remaining = mgr._toast_inbox.get("ses_mute", unacked_only=True)
    assert len(remaining) == 1
    assert remaining[0].acknowledged is False


# =========================================================================== #
# 7. New sessions and forks start unmuted                                     #
# =========================================================================== #


def test_a_fork_of_a_muted_session_starts_unmuted(tmp_path):
    """A mute is a decision about ONE session, not an inherited property.

    The child gets its own row, and the absence of a mute on that row IS
    the answer - there is no backfill and nothing copies the column.
    """
    conn = _make_db(tmp_path / "cloude.db")
    parent_id = _insert_session(conn, session_uuid="parent")
    session_store.set_notification_mute(conn, "parent", muted=True)

    _insert_session(
        conn,
        session_uuid="child",
        tmux_name="cloude_mute_proj_fork",
        epoch=TMUX_EPOCH + 10,
        parent_session_id=parent_id,
    )

    assert session_store.get_notification_policy(conn, "parent")["muted"] is True
    assert session_store.get_notification_policy(conn, "child") == {
        "muted": False,
        "generation": 0,
    }
    conn.close()


def test_a_session_created_after_hydration_is_unmuted_not_unknown(tmp_path):
    """A row the index has not seen is UNMUTED, and definitely so.

    A mute can only ever be recorded on a row, so a session whose row did
    not exist when the index was built has demonstrably never been muted.
    Answering ``unknown`` here would silence every newly created session.
    """
    store = _muted_store()
    verdict = store.for_instance("cloude_brand_new", TMUX_EPOCH + 99)
    assert verdict.verdict == POLICY_UNMUTED
    assert verdict.suppresses is False


# =========================================================================== #
# 8. A reused tmux name cannot be targeted                                    #
# =========================================================================== #


def test_a_reused_name_does_not_inherit_the_dead_session_s_mute():
    """THE SILENT FAILURE THIS KEYING EXISTS TO PREVENT.

    tmux names are reusable and this app re-mints them. A successor
    session that inherited its predecessor's mute would be silent, and
    the user would find out only by missing something. The exact
    instance key answers about the instance it was asked about and
    nothing else - the NAME fallback is reached only when there is no
    epoch to be exact with.
    """
    store = _muted_store()
    # Same name, a later creation epoch: a different session entirely.
    successor = store.for_instance(TMUX_NAME, TMUX_EPOCH + 1)
    assert successor.verdict == POLICY_UNMUTED

    # And the original instance is still muted, so the assertion above is
    # not passing because the index is empty.
    assert store.for_instance(TMUX_NAME, TMUX_EPOCH).verdict == POLICY_MUTED


def test_the_write_refuses_an_expected_instance_that_no_longer_matches(tmp_path):
    """A row action fired from a stale list is REFUSED, not redirected.

    Its own exception type so the route can answer 409 - the row is
    there, it is simply not the session the user was looking at.
    """
    conn = _make_db(tmp_path / "cloude.db")
    _insert_session(conn, session_uuid="u1")

    with pytest.raises(session_store.SessionInstanceMismatchError):
        session_store.set_notification_mute(
            conn,
            "u1",
            muted=True,
            expected_tmux_name=TMUX_NAME,
            expected_tmux_created_epoch=TMUX_EPOCH + 1,
        )
    # Nothing was written.
    assert session_store.get_notification_policy(conn, "u1")["muted"] is False

    # The matching instance still works, so the refusal above is about the
    # epoch and not about the check being broken.
    ok = session_store.set_notification_mute(
        conn,
        "u1",
        muted=True,
        expected_tmux_name=TMUX_NAME,
        expected_tmux_created_epoch=TMUX_EPOCH,
    )
    assert ok["muted"] is True
    conn.close()


# =========================================================================== #
# 9. The route                                                                #
# =========================================================================== #


def _records_app(monkeypatch, tmp_path, store=None):
    """A test app whose ``/sessions/records`` routes see a real database.

    Inputs: monkeypatch, tmp_path. store (NotificationPolicyStore | None).
    Output: (TestClient, sqlite3.Connection, SessionManager).
    """
    state = tmp_path / "state"
    state.mkdir(exist_ok=True)

    class _S:
        def get_state_dir(self):
            return state

    monkeypatch.setattr(routes_mod, "settings", _S())

    from src.core.db import db_path_for

    conn = _make_db(db_path_for(state))

    class _Mgr:
        pass

    mgr = _Mgr()
    mgr._notification_policy_store = store

    app = FastAPI()
    app.state.session_manager = mgr
    app.include_router(routes_mod.router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: True
    return TestClient(app), conn, mgr


def test_the_patch_route_commits_and_reports_the_generation(
    monkeypatch, tmp_path
):
    """The contract: ``{muted}`` in, ``{muted, policy_generation}`` out."""
    client, conn, _ = _records_app(monkeypatch, tmp_path)
    _insert_session(conn, session_uuid="u1")

    resp = client.patch(
        "/api/v1/sessions/records/u1/notifications", json={"muted": True}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"muted": True, "policy_generation": 1}

    # Idempotent: the same request again commits nothing new.
    again = client.patch(
        "/api/v1/sessions/records/u1/notifications", json={"muted": True}
    )
    assert again.json() == {"muted": True, "policy_generation": 1}

    off = client.patch(
        "/api/v1/sessions/records/u1/notifications", json={"muted": False}
    )
    assert off.json() == {"muted": False, "policy_generation": 2}
    conn.close()


def test_the_patch_route_updates_the_live_projection_too(monkeypatch, tmp_path):
    """Durable AND live. A setting that only took effect at the next boot
    would be indistinguishable from a broken one for the whole session
    the user is sitting in."""
    store = NotificationPolicyStore()
    store.hydrate([])
    client, conn, _ = _records_app(monkeypatch, tmp_path, store=store)
    _insert_session(conn, session_uuid="u1")

    client.patch(
        "/api/v1/sessions/records/u1/notifications", json={"muted": True}
    )

    # Both keys: by uuid for the record, and by INSTANCE for the live hook
    # gate. A row created since hydration is in neither until this write.
    assert store.for_uuid("u1").verdict == POLICY_MUTED
    assert store.for_instance(TMUX_NAME, TMUX_EPOCH).verdict == POLICY_MUTED
    conn.close()


def test_the_patch_route_answers_409_for_a_stale_expected_instance(
    monkeypatch, tmp_path
):
    """409, NOT 404. The row exists; the list it was clicked from is old."""
    client, conn, _ = _records_app(monkeypatch, tmp_path)
    _insert_session(conn, session_uuid="u1")

    resp = client.patch(
        "/api/v1/sessions/records/u1/notifications",
        json={
            "muted": True,
            "expected_tmux_name": TMUX_NAME,
            "expected_tmux_created_epoch": TMUX_EPOCH + 1,
        },
    )
    assert resp.status_code == 409, resp.text
    assert session_store.get_notification_policy(conn, "u1")["muted"] is False
    conn.close()


def test_the_patch_route_answers_404_for_an_unknown_row(monkeypatch, tmp_path):
    """No row carries that uuid, so nothing was saved and it says so."""
    client, conn, _ = _records_app(monkeypatch, tmp_path)
    resp = client.patch(
        "/api/v1/sessions/records/ghost/notifications", json={"muted": True}
    )
    assert resp.status_code == 404
    conn.close()


def test_the_records_listing_carries_the_mute(monkeypatch, tmp_path):
    """The launchpad renders its menu off this listing, so the state has
    to be on it - otherwise the label would have to be guessed."""
    client, conn, _ = _records_app(monkeypatch, tmp_path)
    _insert_session(conn, session_uuid="u1")
    client.patch(
        "/api/v1/sessions/records/u1/notifications", json={"muted": True}
    )

    rows = client.get("/api/v1/sessions/records").json()
    row = next(r for r in rows if r["session_uuid"] == "u1")
    assert row["notifications_muted"] is True
    assert row["notification_policy_generation"] == 1
    conn.close()


# =========================================================================== #
# 10. The wrapper field                                                       #
# =========================================================================== #


def test_notifications_muted_is_on_the_wrapper_not_the_nested_session():
    """CLAUDE.md's single most repeated bug, asserted rather than trusted.

    Reading ``info.session.notifications_muted`` gives ``undefined``
    silently and looks exactly like a backend that did not send it.
    """
    from src.models import SessionInfo

    assert "notifications_muted" in SessionInfo.model_fields
    assert "notifications_muted" not in Session.model_fields
    assert SessionInfo.model_fields["notifications_muted"].default is False


# =========================================================================== #
# 11. The app's own startup-prompt alert obeys the mute too                   #
# =========================================================================== #


def test_a_muted_session_raises_no_startup_prompt_toast(monkeypatch, tmp_path):
    """"needs a keypress" is a web alert about this session, so it is muted.

    THE VERDICT IS NOT. The gate still answers
    ``awaiting_startup_prompt``, so the row and the launchpad card still
    say the session is stuck - only the interruption is skipped. And the
    one-shot claim is CONSUMED, so unmuting later resumes future alerts
    without resurrecting a summons about a moment that has passed.
    """
    import time as _time

    from src.core.session_status import LIVENESS_LIVE
    from src.core.session_startup_gate import GATE_AWAITING

    store = _muted_store()
    _, mgr = _build_hook_app(
        monkeypatch, tmp_path, store=store, router=_RecordingRouter()
    )
    monkeypatch.setattr(
        "src.core.session_manager.capture_pane_tail",
        lambda **kwargs: TRUST_PROMPT_TAIL,
    )
    row = {"created_at_epoch": int(_time.time()) - 600, "pid": 4321}

    verdict = mgr._startup_gate_for(
        session_id="ses_mute",
        backend=mgr.backends["ses_mute"],
        tmux_name=TMUX_NAME,
        row=row,
        liveness=LIVENESS_LIVE,
    )

    assert verdict == GATE_AWAITING
    assert mgr._toast_inbox.get("ses_mute") == []
    assert mgr._toast_inbox.pending_startup == []

    # Unmuting does not replay it: the claim was spent while muted.
    store.apply("u1", muted=False, generation=2)
    assert (
        mgr._startup_gate_for(
            session_id="ses_mute",
            backend=mgr.backends["ses_mute"],
            tmux_name=TMUX_NAME,
            row=row,
            liveness=LIVENESS_LIVE,
        )
        == GATE_AWAITING
    )
    assert mgr._toast_inbox.get("ses_mute") == []


def test_an_unmuted_session_still_gets_its_startup_prompt_toast(
    monkeypatch, tmp_path
):
    """The positive control for the gate above."""
    import time as _time

    from src.core.session_status import LIVENESS_LIVE
    from src.core.session_startup_gate import GATE_AWAITING

    _, mgr = _build_hook_app(
        monkeypatch, tmp_path, store=_unmuted_store(), router=_RecordingRouter()
    )
    monkeypatch.setattr(
        "src.core.session_manager.capture_pane_tail",
        lambda **kwargs: TRUST_PROMPT_TAIL,
    )
    row = {"created_at_epoch": int(_time.time()) - 600, "pid": 4321}

    verdict = mgr._startup_gate_for(
        session_id="ses_mute",
        backend=mgr.backends["ses_mute"],
        tmux_name=TMUX_NAME,
        row=row,
        liveness=LIVENESS_LIVE,
    )
    assert verdict == GATE_AWAITING
    assert len(mgr._toast_inbox.get("ses_mute")) == 1
