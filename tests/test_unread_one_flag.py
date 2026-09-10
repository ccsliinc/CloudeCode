"""ONE instance-keyed unread flag, written by two paths and read by every
surface.

WHAT WENT WRONG, AND WHY THE ROUTE ALONE COULD NOT SHOW IT. The manual
mark and the ``Stop`` hook always wrote the same file, and a unit test of
either one in isolation passed. The failure was at the seam: the WRITE
resolved a MEASURED ``#{session_created}`` (``_epoch_for_tmux_name`` asks
tmux), while ``/sessions/list``'s READ used the in-memory
``_instance_epochs`` cache, which is populated only by the create and
adopt persist steps and therefore MISSES for every session that predates
the current server process - which, after any restart, is all of them. A
miss composes the LEGACY bare-name key, which cannot see an entry stored
under ``<name>@<epoch>``. So the flag was written, was on disk, and was
invisible to the endpoint the sidebar reads.

That is the shape this file measures: not "does set_flag work" but "does
the value the writer stored come back out of ``list_session_infos`` when
the read path holds nothing in its cache".

The rule the tests below encode, in the owner's words: "when clicking a
tab, the session is marked read. if i want it unread i click unread. it
allows me to know whats waiting."

Run with:
    venv/bin/python3 -m pytest tests/test_unread_one_flag.py -v
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so `src.config` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_uof_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_uof_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from fastapi import FastAPI
from fastapi.testclient import TestClient

import src.api.routes as routes_mod
from src.api.auth import require_auth
from src.core.session_manager import SessionManager
from src.models import Session, SessionStatus

TMUX_NAME = "cloude_oneflag"
SESSION_ID = "ses_oneflag"
#: The instance's ``#{session_created}``. Any fixed value works; what
#: matters is that the write resolves it and the read has to find the
#: same key without help from ``_instance_epochs``.
EPOCH = 1788444912


class _StubSettings:
    """Just enough of ``Settings`` for ``SessionManager.__init__``."""

    def __init__(self, root: Path):
        self._root = root
        self.port = 5001

    def get_pinned_themes_path(self) -> Path:
        return self._root / "pinned_themes.json"

    def get_unread_state_path(self) -> Path:
        return self._root / "unread_state.json"

    @property
    def log_directory(self) -> str:
        return str(self._root / "logs")

    def get_session_metadata_path(self) -> Path:
        return self._root / "logs" / "session_metadata.json"


class _FakeBackend:
    """Bare enough of a ``SessionBackend`` for the unread paths."""

    def __init__(self, tmux_session: str):
        self.tmux_session = tmux_session

    def is_alive(self) -> bool:
        return True


def _manager(monkeypatch, tmp_path: Path) -> SessionManager:
    """A SessionManager whose tmux is entirely faked, holding one session.

    Description: The status map reports the session ALIVE and carries the
        measured ``created_at_epoch``, exactly as the real bulk
        ``tmux list-panes -a`` probe does. ``list_attachable_sessions`` is
        faked to the same epoch because that is what the manual mark's
        ``_epoch_for_tmux_name`` reads. ``_instance_epochs`` is left EMPTY
        on purpose - that is the post-restart state in which the defect
        lived, so a test that seeded it would measure nothing.
    Inputs: monkeypatch (pytest fixture). tmp_path (Path).
    Output: SessionManager.
    """
    stub = _StubSettings(tmp_path)
    (tmp_path / "logs").mkdir(exist_ok=True)
    monkeypatch.setattr("src.core.session_manager.settings", stub)
    mgr = SessionManager()

    mgr.sessions[SESSION_ID] = Session(
        id=SESSION_ID,
        pty_pid=None,
        working_dir=str(tmp_path),
        status=SessionStatus.RUNNING,
        tmux_session=TMUX_NAME,
    )
    mgr.backends[SESSION_ID] = _FakeBackend(TMUX_NAME)
    mgr._subscribers.setdefault(SESSION_ID, [])

    monkeypatch.setattr(
        mgr,
        "_build_tmux_status_map",
        lambda: {TMUX_NAME: {"status": "idle", "created_at_epoch": EPOCH}},
    )
    monkeypatch.setattr(
        mgr,
        "list_attachable_sessions",
        lambda: [{"name": TMUX_NAME, "created_at_epoch": EPOCH}],
    )
    assert mgr._instance_epochs == {}, "the cache must start empty or this proves nothing"
    return mgr


def _client(mgr: SessionManager) -> TestClient:
    """A TestClient over the real router with auth stubbed out."""
    app = FastAPI()
    app.state.session_manager = mgr
    app.include_router(routes_mod.router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: True
    return TestClient(app)


async def _unread_on_list(mgr: SessionManager) -> bool:
    """What ``GET /sessions/list`` would report for the one session."""
    infos = await mgr.list_session_infos()
    assert len(infos) == 1, f"expected one row, got {len(infos)}"
    return bool(infos[0].unread)


# =========================================================================== #
# 1. The seam: mark through the route, read through the list                  #
# =========================================================================== #


@pytest.mark.asyncio
async def test_marking_through_the_route_shows_unread_on_the_list(monkeypatch, tmp_path):
    mgr = _manager(monkeypatch, tmp_path)
    assert await _unread_on_list(mgr) is False

    resp = _client(mgr).patch(
        f"/api/v1/sessions/{TMUX_NAME}/unread", json={"unread": True}
    )
    assert resp.status_code == 200, resp.text

    assert await _unread_on_list(mgr) is True


@pytest.mark.asyncio
async def test_the_list_read_survives_an_empty_instance_epoch_cache(monkeypatch, tmp_path):
    """THE REGRESSION ITSELF, stated as a key question rather than a flag.

    The write lands on ``<name>@<epoch>``; the read must find it while
    ``_instance_epochs`` holds nothing for this session id. Before the
    fix the read composed the bare name and returned False here while the
    file on disk plainly said otherwise.
    """
    mgr = _manager(monkeypatch, tmp_path)
    mgr.set_manual_unread(TMUX_NAME, True)

    stored = list(mgr._unread_store.raw)
    assert stored == [f"{TMUX_NAME}@{EPOCH}"], stored
    assert SESSION_ID not in mgr._instance_epochs

    assert await _unread_on_list(mgr) is True


@pytest.mark.asyncio
async def test_the_stop_hook_and_the_control_write_the_same_key(monkeypatch, tmp_path):
    """One flag means one key. Two writers, one entry, not two rows."""
    mgr = _manager(monkeypatch, tmp_path)

    mgr.record_hook_event(SESSION_ID, "Stop", {})
    after_hook = set(mgr._unread_store.raw)

    mgr.set_manual_unread(TMUX_NAME, True)
    after_mark = set(mgr._unread_store.raw)

    assert after_hook == after_mark == {f"{TMUX_NAME}@{EPOCH}"}


# =========================================================================== #
# 2. Idempotence, and the two ways it is cleared                              #
# =========================================================================== #


@pytest.mark.asyncio
async def test_marking_twice_is_idempotent(monkeypatch, tmp_path):
    mgr = _manager(monkeypatch, tmp_path)
    client = _client(mgr)

    for _ in range(2):
        assert client.patch(
            f"/api/v1/sessions/{TMUX_NAME}/unread", json={"unread": True}
        ).status_code == 200

    assert await _unread_on_list(mgr) is True
    assert len(mgr._unread_store.raw) == 1


@pytest.mark.asyncio
async def test_unmarking_through_the_route_clears_the_list_field(monkeypatch, tmp_path):
    mgr = _manager(monkeypatch, tmp_path)
    client = _client(mgr)
    client.patch(f"/api/v1/sessions/{TMUX_NAME}/unread", json={"unread": True})
    assert await _unread_on_list(mgr) is True

    assert client.patch(
        f"/api/v1/sessions/{TMUX_NAME}/unread", json={"unread": False}
    ).status_code == 200
    assert await _unread_on_list(mgr) is False
    # Cleared, not left as a hygiene no-op row.
    assert mgr._unread_store.raw == {}


@pytest.mark.asyncio
async def test_unmarking_twice_is_idempotent(monkeypatch, tmp_path):
    mgr = _manager(monkeypatch, tmp_path)
    client = _client(mgr)
    for _ in range(2):
        assert client.patch(
            f"/api/v1/sessions/{TMUX_NAME}/unread", json={"unread": False}
        ).status_code == 200
    assert await _unread_on_list(mgr) is False


@pytest.mark.asyncio
async def test_binding_a_terminal_clears_a_manually_marked_session(monkeypatch, tmp_path):
    """Opening the tab is what marks a session read, whichever writer set
    it. ``mark_session_viewed`` is the call ``bind_session`` makes."""
    mgr = _manager(monkeypatch, tmp_path)
    _client(mgr).patch(f"/api/v1/sessions/{TMUX_NAME}/unread", json={"unread": True})
    assert await _unread_on_list(mgr) is True

    mgr.mark_session_viewed(SESSION_ID)
    assert await _unread_on_list(mgr) is False


@pytest.mark.asyncio
async def test_binding_a_terminal_clears_a_stop_flagged_session(monkeypatch, tmp_path):
    mgr = _manager(monkeypatch, tmp_path)
    mgr.record_hook_event(SESSION_ID, "Stop", {})
    assert await _unread_on_list(mgr) is True

    mgr.mark_session_viewed(SESSION_ID)
    assert await _unread_on_list(mgr) is False


# =========================================================================== #
# 3. Negative control                                                         #
# =========================================================================== #


@pytest.mark.asyncio
async def test_an_unmarked_session_is_not_reported_unread(monkeypatch, tmp_path):
    """A read path that always answered True would pass every test above.

    Nothing is written here at all, and a mark aimed at a DIFFERENT tmux
    name must not reach this row either.
    """
    mgr = _manager(monkeypatch, tmp_path)
    mgr.set_manual_unread("cloude_someone_else", True)
    assert await _unread_on_list(mgr) is False
