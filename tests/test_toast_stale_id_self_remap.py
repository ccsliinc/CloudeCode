"""The stale-id toast remap must never fire against a session that is not

RETARGETED AT THE 1.4.0 INTEGRATION. This line's SessionManager does not
own the live tables or the toast bucket: the registry owns sessions,
backends and the per-viewer subscriber lists, ToastInbox owns the
records, and HookTokenAuthority owns the tokens and the tmux-name map.
The BEHAVIOUR asserted below is unchanged.

stale at all.

THE INCIDENT. Measured over 8 hours of the live server log: 339
``toast_session_id_remapped`` events, every single one with
``stale_id == live_id`` - the real remap has never once fired in
production. The cause was ``auto_ack_toasts``'s guard,
``if session_id not in self._pending_toasts:``, which answers "does this
session have any recorded toasts" rather than "is this session unknown to
me". A live, perfectly registered session with an empty toast bucket (the
common case - most hook events fire on a session that has never raised a
toast) fell into the remap lookup anyway, found its own tmux name in
``_hook_tmux_names``, and matched itself in ``self.sessions``.

TWO FIXES ARE UNDER TEST HERE:

  FIX 1 - the guard in ``SessionManager.auto_ack_toasts`` now reads
      ``if session_id not in self.sessions:``, the question the recovery
      exists to answer.
  FIX 2 - ``_live_session_id_for_stale_id`` itself refuses to report a
      match onto the caller's own id as a remap, defence in depth for any
      caller (present or future) that reaches it with an id already known
      to ``self.sessions``.

NEGATIVE CONTROL IS MANDATORY AND LOAD-BEARING (test 2 below): a genuinely
unknown session id - the case the recovery exists for - must still remap
onto the live session sharing its tmux name. An over-tightened guard (for
example, refusing the lookup outright, or gating on a second condition
that also happens to be true for a stale id) would pass every other test
in this file while breaking exactly the feature this module is defending.
"""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_tsr_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_tsr_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.session_manager import SessionManager
from src.models import Session, SessionStatus


class _StubSettings:
    """Just enough of ``Settings`` for ``SessionManager.__init__`` to load."""

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


def _manager(monkeypatch, tmp_path: Path) -> SessionManager:
    """Description: a SessionManager with no tmux side effects.
    Inputs: monkeypatch, tmp_path. Output: SessionManager.
    """
    (tmp_path / "logs").mkdir(exist_ok=True)
    stub = _StubSettings(tmp_path / "pinned_themes.json", tmp_path / "logs")
    monkeypatch.setattr("src.core.session_manager.settings", stub)
    return SessionManager()


def _session(mgr: SessionManager, sid: str, work: Path, tmux_name: str) -> Session:
    """Description: register a minimal live Session, mirroring what a real
    launch does - the row in ``self.sessions`` AND the hook-token map entry
    in ``_hook_tmux_names`` that ``_live_session_id_for_stale_id`` reads.
    """
    work.mkdir(exist_ok=True, parents=True)
    sess = Session(
        id=sid,
        pty_pid=None,
        working_dir=str(work),
        status=SessionStatus.RUNNING,
        tmux_session=tmux_name,
    )
    mgr._registry.sessions[sid] = sess
    mgr._registry.subscribers.setdefault(sid, [])
    mgr.hook_tokens.tmux_names[sid] = tmux_name
    return sess


# --------------------------------------------------------------------- #
# 1. FIX 1 - a live, known session with an empty bucket never remaps.    #
# --------------------------------------------------------------------- #


def test_live_session_with_empty_bucket_does_not_enter_remap(monkeypatch, tmp_path):
    """The exact shape of the 339-event incident: a registered, live
    session whose toast bucket has never been touched must not even ASK
    the stale-id resolver, because it is not stale."""
    mgr = _manager(monkeypatch, tmp_path)
    _session(mgr, "ses_live", tmp_path / "live", "cloude_ses_live")
    assert "ses_live" not in mgr._toast_inbox.pending, "sanity: bucket genuinely empty"

    calls = []
    original = SessionManager._live_session_id_for_stale_id

    def _spy(self, session_id):
        calls.append(session_id)
        return original(self, session_id)

    with patch.object(SessionManager, "_live_session_id_for_stale_id", _spy):
        changed = mgr.auto_ack_toasts("ses_live", "UserPromptSubmit")

    assert changed == []
    assert calls == [], (
        "a live, registered session must never reach the stale-id "
        "resolver just because its toast bucket happens to be empty"
    )


def test_toast_session_id_remapped_never_logs_for_a_live_known_session(
    monkeypatch, tmp_path, caplog
):
    """Same case, asserted at the log line rather than the call count, so
    the fix is verified against the actual observable that the live
    incident was diagnosed from."""
    import logging

    caplog.set_level(logging.INFO)
    mgr = _manager(monkeypatch, tmp_path)
    _session(mgr, "ses_live2", tmp_path / "live2", "cloude_ses_live2")

    mgr.auto_ack_toasts("ses_live2", "PreToolUse")

    assert "toast_session_id_remapped" not in caplog.text


# --------------------------------------------------------------------- #
# 2. NEGATIVE CONTROL (load-bearing) - a genuinely unknown id still       #
#    remaps onto the live session sharing its tmux name.                 #
# --------------------------------------------------------------------- #


def test_genuinely_stale_id_still_remaps_and_acks(monkeypatch, tmp_path):
    """The case the recovery exists for: a pre-restart id presenting a
    hook for a session that survived under a NEW id. This must keep
    working - an over-tightened guard would break exactly this while
    every test above still passes.

    Verified by mutation: pinning the guard to ``if False:`` (never
    attempt the remap - the shape of an over-tightened fix) makes this
    test fail while test 1 above still passes, confirming this control is
    actually sensitive to the failure it exists to catch.
    """
    mgr = _manager(monkeypatch, tmp_path)
    live = _session(mgr, "ses_live3", tmp_path / "live3", "cloude_ses_live3")
    # The pre-restart id: same tmux name, no row of its own in
    # ``self.sessions`` (it was replaced by ``ses_live3`` on restart), but
    # still present in the persisted hook-token map.
    mgr.hook_tokens.tmux_names["ses_stale"] = "cloude_ses_live3"

    toast = mgr.record_toast("ses_live3", "Stop", "Your turn")
    assert mgr._toast_inbox.get("ses_live3", unacked_only=True) == [toast]

    now = toast.created_at + timedelta(seconds=1)
    changed = mgr.auto_ack_toasts("ses_stale", "UserPromptSubmit", cutoff=now)

    assert changed == [toast.id], (
        "a hook arriving under the pre-restart id must still be able to "
        "ack the surviving session's toast"
    )
    assert mgr._toast_inbox.get("ses_live3", unacked_only=True) == []


# --------------------------------------------------------------------- #
# 3. FIX 2 - the resolver itself refuses to report a self-match.          #
# --------------------------------------------------------------------- #


def test_live_session_id_for_stale_id_returns_none_on_self_match(
    monkeypatch, tmp_path, caplog
):
    """Called directly (bypassing both callers' own guards), so this is a
    test of the resolver's own contract: resolving to the id it was
    handed is not a remap and must not be reported as one."""
    import logging

    caplog.set_level(logging.INFO)
    mgr = _manager(monkeypatch, tmp_path)
    _session(mgr, "ses_self", tmp_path / "self", "cloude_ses_self")

    result = mgr._live_session_id_for_stale_id("ses_self")

    assert result is None
    assert "toast_session_id_remapped" not in caplog.text


def test_live_session_id_for_stale_id_still_finds_a_different_live_session(
    monkeypatch, tmp_path
):
    """Sibling to the self-match refusal: a genuine remap target must
    still be found and logged when one exists and is not the caller."""
    mgr = _manager(monkeypatch, tmp_path)
    _session(mgr, "ses_new", tmp_path / "new", "cloude_shared_name")
    mgr.hook_tokens.tmux_names["ses_old"] = "cloude_shared_name"

    result = mgr._live_session_id_for_stale_id("ses_old")

    assert result == "ses_new"
