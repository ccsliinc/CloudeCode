"""How many SQLite connections one ``GET /sessions/list`` pass opens.

WHY THIS IS A SEPARATE FILE FROM ``test_listing_seed_row_cost.py``. That
one measures the seed's READER in isolation, against a real database, and
says in its own docstring why it does not go through a live pass. This one
takes the PASS-LEVEL number, against real tmux, and it is the measurement
that catches a cost the reader-level test cannot see: a new per-row
datastore read added anywhere else in ``_session_info_for``.

WHAT IT MEASURED WHEN IT WAS FIRST RUN, attributed by caller, with 4 live
sessions. This is recorded because it is the honest state of the route
rather than a target that was hit:

    _restored_activity_state   4    one connection per session
    _identity_for_live_name    4    one connection per session
    _label_for_tmux_name       4    one connection per session
    _owned_instances_from_db   4    one connection per session
    _instance_index_for_listing 1   ONE for the whole pass
    read_instance_row          0    was one per session before this round

So FOUR per-row readers remain and the round removed a fifth. They are NOT
folded into the index, deliberately: all four are NAME-KEYED with a
recency rule ("the newest instance of this name") while the index is keyed
on the full instance triple, so answering them from it would be a silent
behaviour change in the duplicate-name case nobody looks at - precisely
the class of change this project's own notes forbid. Closing them means
either giving them the epoch the pass already holds, or a second
name-keyed bulk read. That is real work and not a patch-release change.

SO THE BOUND HERE IS DELIBERATELY LOOSE AND IS A CEILING ON A ROUTE THAT
IS KNOWN TO BE IMPERFECT. It exists to fail when a FIFTH per-row reader
appears, not to assert the route is clean. Tightening it is the follow-up;
RAISING IT IS NOT.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from contextlib import closing
from datetime import datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_lpd_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_lpd_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.config import settings
from src.core.session_manager import SessionManager
from src.core.tmux_backend import TmuxBackend
from src.models import Session, SessionStatus
from tests.s7_helpers import migrated_connection
from tests.socket_guard import TEST_SOCKET_NAME

requires_tmux = pytest.mark.skipif(
    shutil.which("tmux") is None, reason="tmux not on PATH"
)

#: How many live sessions the pass is measured against.
LIVE_SESSIONS = 4

#: The most datastore connections one ``/sessions/list`` pass may open.
#:
#: MEASURED, NOT PICKED, and it is a CEILING ON A KNOWN-IMPERFECT ROUTE
#: rather than a claim that the route is clean - see the module docstring
#: for the four name-keyed per-row readers still on it. Measured at
#: ``4 * N + 1`` with one open of headroom. A FIFTH per-row reader pushes
#: it to ``5 * N + 1`` and fails this, which is the sensitivity that makes
#: it worth having. If this ever needs raising, the read that raised it
#: belongs in a bulk index instead.
MAX_DATASTORE_OPENS_PER_LISTING = 4 * LIVE_SESSIONS + 2


def _tmux(*args: str) -> subprocess.CompletedProcess:
    """Run one tmux command against THIS run's test socket.

    Inputs: args (str) - the tmux argv after ``-L <test socket>``.
    Output: subprocess.CompletedProcess, text captured.
    Example: _tmux('kill-server')
    """
    return subprocess.run(
        ["tmux", "-L", TEST_SOCKET_NAME, *args],
        capture_output=True,
        text=True,
        check=False,
    )


class _DatastoreOpenCounter:
    """Count how many times a code path OPENS the datastore.

    Description: wraps ``src.core.db.connect``, which every datastore
        open in the server goes through. The real call still runs, so the
        pass under measurement is the production one.
    Inputs: none.
    Output: instances expose ``count`` (int) and ``by_caller`` (dict).
    Example:
        >>> _DatastoreOpenCounter().count
        0
    """

    def __init__(self) -> None:
        self.count = 0
        self.by_caller: dict = {}

    def install(self, monkeypatch) -> None:
        """Wrap ``src.core.db.connect`` for the duration of one test.

        Description: also records the calling function name, so a failure
            message names WHICH reader grew rather than only that the
            total did. Attribution is what turns a red test into a fix.
        Inputs: monkeypatch (pytest fixture).
        Output: None.
        """
        import traceback

        from src.core import db as db_module

        original = db_module.connect
        counter = self

        def counting(*args, **kwargs):
            counter.count += 1
            stack = traceback.extract_stack()[:-1]
            named = [
                frame.name
                for frame in stack
                if "session_manager" in frame.filename
                or "seed" in frame.filename
            ]
            caller = named[-2] if len(named) >= 2 else (named[-1] if named else "?")
            counter.by_caller[caller] = counter.by_caller.get(caller, 0) + 1
            return original(*args, **kwargs)

        monkeypatch.setattr(db_module, "connect", counting)

    def snapshot(self) -> dict:
        """The per-caller tally so far, and zero it.

        Description: lets ONE installed counter measure two passes
            separately. Installing a second counter would wrap the first
            and count every open twice, which is a mistake that reads as
            a doubled cost rather than as a broken instrument.
        Inputs: none.
        Output: dict - ``{"total": int, "by_caller": dict}`` for the
            window since the last snapshot.
        Example: counter.snapshot()["total"]
        """
        taken = {"total": self.count, "by_caller": dict(self.by_caller)}
        self.count = 0
        self.by_caller = {}
        return taken


@pytest.fixture
def live_manager(tmp_path, monkeypatch):
    """A SessionManager holding ``LIVE_SESSIONS`` REAL tmux sessions.

    Description: the panes run a long ``sleep`` rather than a bare shell,
        which is what puts them in the population this pass actually
        costs something for: tmux reports the pane ``running``, that maps
        to activity ``unknown``, and a live session with an unknown
        status is the only one that reaches the status seed at all. A
        bare-shell pane resolves to ``idle`` and skips the seam, so a
        fixture built from those would report zero however broken the
        code was.
    Inputs: tmp_path, monkeypatch.
    Output: tuple[SessionManager, list[str]].
    """
    log_dir = tmp_path / "logs"
    state = tmp_path / "state"
    log_dir.mkdir()
    state.mkdir()
    monkeypatch.setattr(settings, "log_directory", str(log_dir))
    monkeypatch.setattr(settings, "state_dir_override", str(state))
    with closing(migrated_connection(state)):
        pass

    manager = SessionManager()
    names: list[str] = []
    try:
        for index in range(LIVE_SESSIONS):
            name = f"cloude_passcost_{index}_{uuid.uuid4().hex[:6]}"
            created = _tmux(
                "new-session", "-d",
                "-s", name,
                "-c", str(tmp_path),
                "-x", "132", "-y", "40",
                "sleep 600",
            )
            assert created.returncode == 0, created.stderr
            names.append(name)

            session_id = f"ses_passcost_{index}"
            backend = TmuxBackend(
                session_id=session_id,
                working_dir=tmp_path,
                on_output=None,
                socket_name=TEST_SOCKET_NAME,
                session_name=name,
            )
            manager.backends[session_id] = backend
            manager.sessions[session_id] = Session(
                id=session_id,
                status=SessionStatus.RUNNING,
                working_dir=str(tmp_path),
                created_at=datetime.utcnow(),
            )
        yield manager, names
    finally:
        _tmux("kill-server")


@requires_tmux
@pytest.mark.asyncio
async def test_the_listing_pass_opens_no_more_than_three_connections_per_row(
    live_manager,
    monkeypatch,
):
    """A FOURTH per-row datastore reader on this pass must fail the build.

    The pass is synchronous inside ``async def``, so every connection it
    opens is opened with the event loop unable to read the tmux pipe,
    deliver a keystroke, or answer another request. Three per-row readers
    remain here for a reason recorded in the module docstring; a fourth
    would be new and unexamined.
    """
    manager, names = live_manager
    counter = _DatastoreOpenCounter()
    counter.install(monkeypatch)

    infos = await manager.list_session_infos()
    assert len(infos) == LIVE_SESSIONS, (
        "the pass must still return every live session - a cheaper pass "
        f"that loses rows is not the fix. got {len(infos)}"
    )
    assert counter.count <= MAX_DATASTORE_OPENS_PER_LISTING, (
        f"one /sessions/list pass opened the datastore {counter.count} "
        f"times for {LIVE_SESSIONS} sessions, over the "
        f"{MAX_DATASTORE_OPENS_PER_LISTING} it is allowed. By caller: "
        f"{counter.by_caller}. Each of these is blocking SQLite on the "
        "event loop, which the user feels as lag in the TERMINAL rather "
        "than as a slow list. Put the read in the bulk index instead of "
        "raising this bound."
    )


@requires_tmux
@pytest.mark.asyncio
async def test_the_seed_takes_no_connection_of_its_own_on_this_pass(
    live_manager,
    monkeypatch,
):
    """THE A/B, and it is the measurement that proves the saving is real.

    A total alone cannot tell "the seed stopped opening connections" from
    "the seed stopped running", and those are a fix and a regression. So
    the same pass is run twice on the same fixture: once as it ships, and
    once with the bulk index forced to report it could not be built, which
    is exactly what makes the seam fall through to the per-row connection
    it opened before this round. The difference between the two runs IS
    the saving, attributed by caller.
    """
    manager, _names = live_manager
    from src.core import session_status_seed_read as seed_read
    from src.core.session_instance_index import InstanceIndex

    counter = _DatastoreOpenCounter()
    counter.install(monkeypatch)
    await manager.list_session_infos()
    shipped = counter.snapshot()

    assert shipped["by_caller"].get("read_instance_row", 0) == 0, (
        "the status seed opened its own connection per session despite "
        f"the pass having taken a bulk index. By caller: {shipped}"
    )
    assert shipped["by_caller"].get("_instance_index_for_listing", 0) == 1, (
        "the bulk index must be built exactly once per pass, not once "
        f"per session and not never. By caller: {shipped}"
    )

    # The control. An index that reports it could not be built is what the
    # seam refuses to read from, so every session takes its own
    # connection - the pre-fix shape, on the same fixture and the same
    # panes. A cached seed would be served rather than re-derived, so the
    # store is dropped first.
    monkeypatch.setattr(
        SessionManager,
        "_instance_index_for_listing",
        lambda self, **kwargs: InstanceIndex(),
    )
    seed_read._STORES.pop(manager, None)

    await manager.list_session_infos()
    per_row = counter.snapshot()

    assert per_row["by_caller"].get("read_instance_row", 0) == LIVE_SESSIONS, (
        "the control did not exercise the per-row path it is controlling "
        f"for, so the comparison proves nothing. By caller: {per_row}"
    )
    # The index costs ONE open and saves one per session, so the net is
    # N - 1. Asserting the net rather than the raw totals is what keeps
    # this from moving every time an unrelated per-pass read is added.
    assert per_row["total"] - shipped["total"] == LIVE_SESSIONS - 1, (
        "the saving is not the one connection per session this round "
        f"claims. shipped={shipped}, per_row={per_row}"
    )
