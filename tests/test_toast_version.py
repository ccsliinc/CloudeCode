"""Server-side toast versioning: issue #39's remaining half.

The client-side render batching (client/js/toast-render-batch.js) landed
first and needed a way to tell a duplicated or out-of-order hook-fed
update apart from a genuine change, so a stale delivery cannot regress a
card already on screen. This is that mechanism.

THE RULE, copied from client/js/preferences.js's `preferences.changed`
revision (CLAUDE.md: "the revision moves only on a real change"), never
reinvented: `Toast.version` is a per-record integer, starting at 1, that
`SessionManager.record_toast` bumps ONLY when a superseded record's
content actually differs from what is held, and `SessionManager.ack_toast`
bumps ONCE on the acked transition. Hook events arrive unordered,
duplicated and droppable (CLAUDE.md), so:

  * the same hook event delivered twice must produce the same version,
    not two bumps - tested below by calling record_toast/ack_toast with
    identical arguments more than once and asserting the version held
    still, not just that it moved somewhere;
  * a re-raise that changes nothing must not bump the version, because a
    client comparing versions would otherwise re-render for no reason,
    which is the exact waste issue #39 exists to remove.

These tests assert on stored state (`get_toasts`), the same discipline
tests/test_toast_supersede.py already uses, never on a call having
happened.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_tv_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_tv_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.session_manager import SessionManager
from src.models import Session, SessionStatus, Toast


class _StubSettings:
    """Just enough of ``Settings`` for ``SessionManager.__init__``."""

    def __init__(self, pin_path: Path, log_dir: Path):
        self._pin_path = pin_path
        self._log_dir = log_dir

    def get_pinned_themes_path(self) -> Path:
        return self._pin_path

    def get_unread_state_path(self) -> Path:
        return self._pin_path.parent / "unread_state.json"

    @property
    def log_directory(self) -> str:
        return str(self._log_dir)

    def get_session_metadata_path(self) -> Path:
        return self._log_dir / "session_metadata.json"


@pytest.fixture()
def mgr(monkeypatch, tmp_path) -> SessionManager:
    """A SessionManager with no tmux side effects and one live session."""
    (tmp_path / "logs").mkdir(exist_ok=True)
    monkeypatch.setattr(
        "src.core.session_manager.settings",
        _StubSettings(tmp_path / "pinned_themes.json", tmp_path / "logs"),
    )
    manager = SessionManager()
    work = tmp_path / "proj"
    work.mkdir()
    manager.sessions["ses_a"] = Session(
        id="ses_a",
        pty_pid=None,
        working_dir=str(work),
        status=SessionStatus.RUNNING,
        tmux_session=None,
    )
    manager._subscribers.setdefault("ses_a", [])
    return manager


# --------------------------------------------------------------------- #
# the model itself                                                       #
# --------------------------------------------------------------------- #


def test_the_model_defaults_a_bare_toast_to_version_one():
    """A ``Toast`` built without naming ``version`` still carries one -
    every record this server ever mints starts real, never absent."""
    t = Toast(id="x", session_id="ses_a", kind="Notification", title="hi")
    assert t.version == 1


# --------------------------------------------------------------------- #
# 1. a real change bumps the version; a no-op re-raise does not.         #
# --------------------------------------------------------------------- #


def test_a_new_toast_starts_at_version_one(mgr):
    t = mgr.record_toast("ses_a", "Notification", "look at this", "first")
    assert t.version == 1


def test_a_real_content_change_on_supersede_bumps_the_version(mgr):
    first = mgr.record_toast("ses_a", "Stop", "Your turn", body="turn one")
    assert first.version == 1
    second = mgr.record_toast("ses_a", "Stop", "Your turn", body="turn two")
    assert second.id == first.id, "supersession must keep the id"
    assert second.version == 2, "a genuinely different body is a real change"


def test_an_identical_reraise_does_not_bump_the_version(mgr):
    """THE NEGATIVE HALF OF THE CASE ABOVE. Same kind, same title, same
    body - the common case of a duplicated ``Stop`` hook delivery, per
    CLAUDE.md's own note that every older unacked Stop says the same
    thing the newest one does. Bumping here would make a client discard
    nothing useful while still re-rendering for it."""
    first = mgr.record_toast("ses_a", "Stop", "Your turn", body="same body")
    again = mgr.record_toast("ses_a", "Stop", "Your turn", body="same body")
    assert again.id == first.id
    assert again.version == 1, (
        "an identical re-raise must not move the version - it carries no "
        "new information for a client to apply"
    )


def test_three_identical_reraises_still_hold_version_one(mgr):
    """Not just "moved somewhere else" - PINNED. A version that merely
    changed on each call would still pass a looser "different from
    before" assertion while failing the actual rule."""
    for _ in range(3):
        mgr.record_toast("ses_a", "Stop", "Your turn", body="steady")
    stored = mgr.get_toasts("ses_a", unacked_only=True)
    assert len(stored) == 1
    assert stored[0].version == 1


def test_repeated_real_changes_bump_once_each(mgr):
    """A genuinely different body every time advances the version by
    exactly one per call, never more and never less."""
    bodies = ["a", "b", "c", "d"]
    last = None
    for i, body in enumerate(bodies, start=1):
        last = mgr.record_toast("ses_a", "Stop", "Your turn", body=body)
        assert last.version == i
    assert last.body == "d"


def test_a_color_only_change_still_counts_as_real(mgr):
    """The accent color is baked onto the record at record time
    (`_get_session_accent_color`), so a theme change between two raises
    of the same Stop is real content, not bookkeeping, even when the
    body is unchanged."""
    first = mgr.record_toast("ses_a", "Stop", "Your turn", body="same")
    first.color = "#111111"  # simulate the pre-existing record's color
    second = mgr.record_toast("ses_a", "Stop", "Your turn", body="same")
    # The session's resolved accent (None, in this fixture with no theme)
    # differs from the color we just forced onto the stored record, so
    # this must read as a real change.
    assert second.version == 2


# --------------------------------------------------------------------- #
# 2. the same hook event delivered twice does not bump twice.            #
# --------------------------------------------------------------------- #


def test_duplicate_hook_delivered_toast_creation_is_not_double_counted(mgr):
    """A duplicated FIRST-EVER Stop (never superseded, because nothing
    existed to supersede) is two separate `record_toast` calls only if
    the caller invokes it twice - which mirrors production exactly: the
    route calls `record_toast` once per POST, so a duplicated hook POST
    is what this test drives. The second delivery supersedes the first
    with identical content and must not bump."""
    a = mgr.record_toast("ses_a", "Stop", "Your turn", body=None)
    b = mgr.record_toast("ses_a", "Stop", "Your turn", body=None)
    assert a.id == b.id
    assert b.version == 1


def test_duplicate_ack_does_not_bump_twice(mgr):
    t = mgr.record_toast("ses_a", "Notification", "hi", "body")
    assert t.version == 1
    first_ack = mgr.ack_toast("ses_a", t.id)
    assert first_ack is True
    after_first = mgr.get_toasts("ses_a")[0]
    assert after_first.version == 2, "the ack transition is a real change"

    # THE DUPLICATE. Idempotent per ack_toast's own docstring: returns
    # False and changes nothing on an already-acked record.
    second_ack = mgr.ack_toast("ses_a", t.id)
    assert second_ack is False
    after_second = mgr.get_toasts("ses_a")[0]
    assert after_second.version == 2, (
        "a duplicated ack of the same record must not move the version "
        "a second time"
    )


def test_duplicate_auto_ack_does_not_bump_twice(mgr):
    """The hook-driven path (``auto_ack_toasts``) routes through the same
    ``ack_toast`` idempotency guard, so a duplicated hook event answering
    the same toast twice must not double-bump either."""
    from datetime import datetime, timedelta

    t = mgr.record_toast("ses_a", "PermissionRequest", "allow?", "cmd")
    cutoff = datetime.utcnow() + timedelta(seconds=1)
    first = mgr.auto_ack_toasts("ses_a", "PreToolUse", cutoff=cutoff)
    assert first == [t.id]
    after_first = mgr.get_toasts("ses_a")[0]
    assert after_first.version == 2

    second = mgr.auto_ack_toasts("ses_a", "PreToolUse", cutoff=cutoff)
    assert second == [], "already answered - nothing changed the second time"
    after_second = mgr.get_toasts("ses_a")[0]
    assert after_second.version == 2


# --------------------------------------------------------------------- #
# 4 (server side). unrelated toasts and unrelated kinds are unaffected.  #
# --------------------------------------------------------------------- #


def test_notifications_never_supersede_so_each_starts_at_version_one(mgr):
    """Notification is not a superseding kind (tests/test_toast_supersede.py
    already covers why); each is its own record and its own version
    history, never inherited from a sibling."""
    for i in range(3):
        mgr.record_toast("ses_a", "Notification", "Waiting", body=f"msg {i}")
    stored = mgr.get_toasts("ses_a")
    assert len(stored) == 3
    assert all(t.version == 1 for t in stored)


def test_acking_one_toast_does_not_touch_anothers_version(mgr):
    a = mgr.record_toast("ses_a", "Notification", "a", "body a")
    b = mgr.record_toast("ses_a", "PermissionRequest", "b", "body b")
    mgr.ack_toast("ses_a", a.id)
    by_id = {t.id: t for t in mgr.get_toasts("ses_a")}
    assert by_id[a.id].version == 2
    assert by_id[b.id].version == 1, "acking a lives entirely on a's record"
