"""S3: the toast cluster moved to ``ToastInbox``, and it MOVED not copied.

Slice S3 of the ``session_manager`` decomposition
(``.claude/notes/backend-decomposition-plan.md``). ``_pending_toasts`` and
``_pending_startup_toasts`` left the god object for
``src/core/sessions/toast_inbox.py``, along with the acked-tail cap, the
supersession rule and the startup queue.

**THE NO-COPY LEGS, AND THE ONE THIS CLUSTER ADDS.** S1's cluster was
scalars, S2's was dicts a caller REBINDS. This one is containers reached
by a DEFENSIVE ACCESSOR from another module:
``src/core/toast_history.py`` reads ``getattr(manager, "_pending_toasts",
None)`` and answers ``{}`` for anything that is not a Mapping. That is
deliberate and documented there - and it means a facade that stopped
exposing the name would show an EMPTY toast history on every surface
while raising nowhere and failing no existing test. That is the exact
shape CLAUDE.md calls the characteristic failure of this refactor, so it
gets its own leg here rather than being trusted.

The legs: (a) identity of both containers; (b) neither name is an
instance attribute on the facade and both are properties on the class;
(c) writes through either spelling are seen by the other; (d) live
delegation through the real public methods; (e) the defensive reader in
``toast_history`` sees the real records through the facade.

**THE INBOX'S OWN RULES GET NEGATIVE CONTROLS**, because each of them is
a rule about what must NOT happen: an acked record must never be
superseded, an already-acked record must never be re-stamped, and the
unacked half must never be capped.

Run with:
    ./venv/bin/python3 -m pytest tests/test_toast_inbox.py -v
"""

from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_ti_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_ti_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core import toast_auto_ack, toast_history
from src.core.session_manager import SessionManager
from src.core.sessions.toast_inbox import ToastInbox
from src.models import Session, SessionStatus


# --------------------------------------------------------------------------- #
# Fixtures                                                                     #
# --------------------------------------------------------------------------- #


class _StubSettings:
    """Just enough of ``Settings`` for ``SessionManager.__init__`` to load."""

    def __init__(self, pin_path: Path, log_dir: Path) -> None:
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
def inbox() -> ToastInbox:
    """A bare inbox. No manager, no tmux, no disk - the point of the split."""
    return ToastInbox()


@pytest.fixture()
def manager(monkeypatch, tmp_path: Path) -> SessionManager:
    """A bare ``SessionManager()`` with its state redirected to tmp_path."""
    (tmp_path / "logs").mkdir(exist_ok=True)
    monkeypatch.setattr(
        "src.core.session_manager.settings",
        _StubSettings(
            pin_path=tmp_path / "pinned_themes.json",
            log_dir=tmp_path / "logs",
        ),
    )
    return SessionManager()


def _register(manager: SessionManager, session_id: str, work: Path) -> Session:
    """Put a minimal live Session on the manager so record_toast accepts it.

    Description: ``record_toast`` refuses an unknown id, correctly, so a
      toast test needs a session in the registry. Nothing here touches
      tmux.
    Inputs: manager, session_id (str), work (Path) - the working dir.
    Output: Session - the registered record.
    """
    sess = Session(
        id=session_id,
        pty_pid=0,
        working_dir=str(work),
        status=SessionStatus.RUNNING,
        tmux_session=f"cloude_{session_id}",
    )
    manager._registry.sessions[session_id] = sess
    return sess


def _store(inbox: ToastInbox, session_id: str, *, kind: str, title: str,
           body: str | None = None, now: datetime | None = None):
    """Store one record with the boring fields filled in.

    Description: keeps the tests about the RULES rather than about the
      seven keyword arguments the real caller resolves elsewhere.
    Output: tuple[Toast, bool] - as ``ToastInbox.store`` returns.
    """
    return inbox.store(
        session_id,
        kind=kind,
        title=title,
        body=body,
        color=None,
        session_label=None,
        session_name=None,
        now=now,
    )


# --------------------------------------------------------------------------- #
# 1. The no-copy rule                                                         #
# --------------------------------------------------------------------------- #


def test_leg_a_the_facade_containers_are_the_inbox_containers(manager):
    """LEG (a). One dict and one list, reached through two spellings each."""
    assert manager._toast_inbox.pending is manager._toast_inbox.pending
    assert manager._toast_inbox.pending_startup is manager._toast_inbox.pending_startup


def test_leg_b_the_facade_holds_no_door_onto_the_cluster(manager):
    """LEG (b), REWRITTEN BY S1. There is no second name at all now.

    Description: this used to assert the two names were PROPERTIES on the
      class rather than fields on the instance, which was the right check
      while the facade forwarded. S1 deleted the forwarders, so the
      invariant is stronger and simpler: the manager has no such
      attribute, by either route. A property coming back would be a
      forwarder coming back.
    """
    moved = ["_pending_toasts", "_pending_startup_toasts"]

    leftovers = [name for name in moved if hasattr(manager, name)]
    assert leftovers == [], (
        f"{leftovers} resolve on the facade again; the toast cluster is "
        "reached through the inbox and nothing else"
    )
    assert manager._toast_inbox.pending is not None


def test_leg_c_writes_cross_in_both_directions(manager, tmp_path):
    """LEG (c). Mutation either way is visible from the other side."""
    _register(manager, "ses_x", tmp_path)

    manager.record_toast("ses_x", "Notification", "hello")
    assert list(manager._toast_inbox.pending) == ["ses_x"]

    manager._toast_inbox.pending.setdefault("ses_direct", [])
    assert "ses_direct" in manager._toast_inbox.pending

    manager._toast_inbox.queue_startup("ses_x", manager._toast_inbox.get("ses_x")[0])
    assert len(manager._toast_inbox.pending_startup) == 1


def test_leg_d_the_public_methods_read_and_write_the_inbox(manager, tmp_path):
    """LEG (d). Live delegation through the four real public methods."""
    _register(manager, "ses_d", tmp_path)

    toast = manager.record_toast("ses_d", "PermissionRequest", "may i")
    assert manager._toast_inbox.pending["ses_d"][0] is toast

    assert manager._toast_inbox.get("ses_d", unacked_only=True) == [toast]
    assert manager._toast_inbox.ack("ses_d", toast.id, toast_auto_ack.ACK_REASON_DISMISSED) is True
    assert manager._toast_inbox.pending["ses_d"][0].acknowledged is True
    assert manager._toast_inbox.get("ses_d", unacked_only=True) == []


def test_leg_e_the_history_reader_sees_the_records_and_no_longer_guesses(
    manager, tmp_path
):
    """LEG (e). THE ONE THIS CLUSTER ADDS, and it used to fail quietly.

    ``toast_history`` read the manager's ``_pending_toasts`` through a
    tolerant ``getattr(..., None)`` that answered ``{}`` for anything
    unrecognised. Drop the facade property and every history view went
    empty while nothing raised and no existing test failed. That is the
    characteristic failure of this refactor, named in CLAUDE.md.

    S1 repointed the reader at the inbox and REMOVED the tolerance, so
    this asserts both halves: the reader gets the real dict, and a wrong
    object now raises instead of answering emptily.
    """
    _register(manager, "ses_h", tmp_path)
    toast = manager.record_toast("ses_h", "Stop", "Your turn")

    buckets = toast_history.buckets_from_inbox(manager._toast_inbox)

    assert buckets is manager._toast_inbox.pending, (
        "toast_history is reading something other than the inbox's records"
    )
    assert toast_history.collect_toasts(buckets) == [toast]

    # NEGATIVE CONTROL, INVERTED BY S1. This used to assert that an
    # unrecognised object yields {} - the silent answer a dropped property
    # produced. It must now RAISE, which is what makes the next such move
    # a crash rather than an empty page.
    with pytest.raises(AttributeError):
        toast_history.buckets_from_inbox(object())


# --------------------------------------------------------------------------- #
# 2. Supersession                                                             #
# --------------------------------------------------------------------------- #


def test_a_second_stop_replaces_the_first_and_keeps_its_id(inbox):
    """One card, one id, however many turns went by unread."""
    first, was_superseded = _store(inbox, "s", kind="Stop", title="Your turn")
    assert was_superseded is False

    second, was_superseded = _store(
        inbox, "s", kind="Stop", title="Your turn", body="later"
    )

    assert was_superseded is True
    assert second is first
    assert second.id == first.id
    assert second.body == "later"
    assert len(inbox.bucket("s")) == 1


def test_an_acked_stop_is_never_superseded(inbox):
    """NEGATIVE CONTROL. A dismissal is history and must not be rewritten.

    Reusing a dismissed record's id would leave the browser holding an id
    the backfill has already stopped serving, and mutating its body would
    rewrite an act the user performed. A new turn after a dismissal is a
    genuinely new notification.
    """
    first, _ = _store(inbox, "s", kind="Stop", title="Your turn")
    assert inbox.ack("s", first.id, reason="dismissed") is True

    second, was_superseded = _store(inbox, "s", kind="Stop", title="Your turn")

    assert was_superseded is False
    assert second.id != first.id
    assert len(inbox.bucket("s")) == 2
    assert first.acknowledged is True


def test_notifications_and_permissions_never_supersede(inbox):
    """NEGATIVE CONTROL, and the reason the kind set has one element.

    Two Notifications are two things to read. Two PermissionRequests are
    two distinct decisions about two distinct commands; collapsing one
    would discard a command the user was never shown.
    """
    for kind in ("Notification", "PermissionRequest"):
        _store(inbox, kind, kind=kind, title="same title")
        _store(inbox, kind, kind=kind, title="same title")
        assert len(inbox.bucket(kind)) == 2, f"{kind} collapsed"


def test_a_different_title_does_not_supersede(inbox):
    """The match key is (kind, title), same as the client's coalesce key."""
    _store(inbox, "s", kind="Stop", title="Your turn")
    _store(inbox, "s", kind="Stop", title="Something else")
    assert len(inbox.bucket("s")) == 2


def test_find_supersedable_answers_none_for_an_empty_bucket(inbox):
    """A matcher that always finds something is worse than useless."""
    assert inbox.find_supersedable([], "Stop", "Your turn") is None


# --------------------------------------------------------------------------- #
# 3. Acking                                                                   #
# --------------------------------------------------------------------------- #


def test_ack_reports_the_transition_not_the_lookup(inbox):
    """True only when state CHANGED, which is what gates the WS broadcast."""
    toast, _ = _store(inbox, "s", kind="Stop", title="Your turn")

    assert inbox.ack("s", toast.id, reason="dismissed") is True
    assert inbox.ack("s", toast.id, reason="dismissed") is False
    assert inbox.ack("s", "no_such_id", reason="dismissed") is False
    assert inbox.ack("no_such_session", toast.id, reason="dismissed") is False


def test_a_duplicate_ack_cannot_rewrite_the_reason(inbox):
    """NEGATIVE CONTROL. Hook events are duplicated by contract.

    The reason is stamped ONLY on the transition. A duplicate arriving
    with a different reason must not be able to relabel an act the user
    already performed.
    """
    toast, _ = _store(inbox, "s", kind="PermissionRequest", title="may i")
    inbox.ack("s", toast.id, reason=toast_auto_ack.ACK_REASON_DISMISSED)

    inbox.ack("s", toast.id, reason=toast_auto_ack.ACK_REASON_ANSWERED)

    assert toast.ack_reason == toast_auto_ack.ACK_REASON_DISMISSED


def test_acking_is_scoped_to_the_session(inbox):
    """NEGATIVE CONTROL. A toast id from another session is not found."""
    mine, _ = _store(inbox, "mine", kind="Stop", title="Your turn")
    _store(inbox, "yours", kind="Stop", title="Your turn")

    assert inbox.ack("yours", mine.id, reason="dismissed") is False
    assert mine.acknowledged is False


# --------------------------------------------------------------------------- #
# 4. Pruning, and the asymmetry that is the whole rule                        #
# --------------------------------------------------------------------------- #


def test_the_cap_drops_only_the_oldest_acked(inbox):
    """Acked records past the cap fall off the tail, which is the oldest."""
    made = []
    for i in range(inbox.ACKED_CAP + 10):
        toast, _ = _store(inbox, "s", kind="Notification", title=f"n{i}")
        inbox.ack("s", toast.id, reason="dismissed")
        made.append(toast)

    bucket = inbox.bucket("s")
    assert len(bucket) == inbox.ACKED_CAP
    # Newest-first, so the survivors are the LAST ones created.
    assert bucket[0] is made[-1]
    assert made[0] not in bucket


def test_the_unacked_half_is_never_capped(inbox):
    """NEGATIVE CONTROL, and the most important rule in this module.

    A cap on the unacked half would drop a notification the user has not
    seen. There is deliberately no number here to compare against: the
    assertion is that ALL of them survive, however many there are.
    """
    count = inbox.ACKED_CAP * 3
    for i in range(count):
        _store(inbox, "s", kind="Notification", title=f"n{i}")

    assert len(inbox.get("s", unacked_only=True)) == count


def test_pruning_an_unknown_session_is_a_noop(inbox):
    """And does not create a bucket, so a read cannot grow the map."""
    inbox.prune("never_seen")
    assert inbox.pending == {}


def test_a_read_does_not_create_a_bucket(inbox):
    """NEGATIVE CONTROL on ``bucket`` and ``get``.

    ``store`` uses ``setdefault`` and must; a READ using it would grow the
    map on every poll for every session that has never had a toast.
    """
    assert inbox.bucket("nobody") == []
    assert inbox.get("nobody") == []
    assert inbox.has("nobody") is False
    assert inbox.pending == {}


def test_dropping_a_session_leaves_the_others_alone(inbox):
    """The isolation the per-session keying exists for."""
    _store(inbox, "a", kind="Stop", title="Your turn")
    _store(inbox, "b", kind="Stop", title="Your turn")

    inbox.drop_session("a")

    assert inbox.has("a") is False
    assert len(inbox.bucket("b")) == 1


def test_get_returns_a_copy_so_a_caller_cannot_mutate_the_store(inbox):
    """The list is a copy; the RECORDS in it are the real ones."""
    toast, _ = _store(inbox, "s", kind="Stop", title="Your turn")
    got = inbox.get("s")

    got.clear()

    assert len(inbox.bucket("s")) == 1
    assert inbox.bucket("s")[0] is toast


# --------------------------------------------------------------------------- #
# 5. The startup queue                                                        #
# --------------------------------------------------------------------------- #


def test_the_startup_queue_drains_once(inbox):
    """DRAINED BEFORE THE SEND, so a failed broadcast cannot re-send.

    A once-per-instance toast that a failing broadcast turned into a
    once-per-poll one would be worse than losing it: the client backfills
    unacked toasts on attach, which is the recovery path.
    """
    toast, _ = _store(inbox, "s", kind="StartupPrompt", title="needs a keypress")
    inbox.queue_startup("s", toast)

    assert inbox.drain_startup() == [("s", toast)]
    assert inbox.drain_startup() == []
    assert inbox.pending_startup == []


# --------------------------------------------------------------------------- #
# 6. End to end through the facade, including the plan's named case           #
# --------------------------------------------------------------------------- #


def test_a_duplicated_stop_acks_by_kind_and_not_the_toast_it_just_raised(
    manager, tmp_path
):
    """THE RULE THE PLAN ASKED FOR, asserted end to end rather than in prose.

    A ``Stop`` both RAISES a "your turn" toast and ACKS a session's open
    permission or notice. It must never ack the toast it just raised, and
    the rule has to survive the event arriving twice - hook events are
    duplicated by contract. Two halves, and both matter: the ack is keyed
    by KIND (so a reorder or a duplicate cannot make it apply to the
    wrong record), and the cutoff is the EVENT's instant (so a toast
    raised after it is out of reach).
    """
    _register(manager, "ses_e", tmp_path)

    permission = manager.record_toast("ses_e", "PermissionRequest", "may i")
    notice = manager.record_toast("ses_e", "Notification", "look at me")

    # The Stop arrives, raising its own toast at this instant.
    cutoff = datetime.utcnow()
    your_turn = manager.record_toast("ses_e", "Stop", "Your turn")

    first = manager.auto_ack_toasts("ses_e", "Stop", cutoff=cutoff)

    assert set(first) == {permission.id, notice.id}
    assert your_turn.id not in first, (
        "the Stop acked the toast it had just raised"
    )
    assert manager._toast_inbox.get("ses_e", unacked_only=True) == [your_turn]

    # THE DUPLICATE. Same event again: nothing changed state, so the
    # caller broadcasts nothing, and the "your turn" is still standing.
    assert manager.auto_ack_toasts("ses_e", "Stop", cutoff=cutoff) == []
    assert manager._toast_inbox.get("ses_e", unacked_only=True) == [your_turn]


def test_a_stop_does_not_ack_a_permission_raised_after_it(manager, tmp_path):
    """NEGATIVE CONTROL on the cutoff. Later evidence is out of reach."""
    _register(manager, "ses_f", tmp_path)
    cutoff = datetime.utcnow() - timedelta(seconds=5)
    later = manager.record_toast("ses_f", "PermissionRequest", "may i")

    assert manager.auto_ack_toasts("ses_f", "Stop", cutoff=cutoff) == []
    assert later.acknowledged is False


def test_wiping_a_session_clears_its_records_through_the_inbox(
    manager, tmp_path
):
    """``_wipe_session_state`` reaches the inbox, not a stale facade dict."""
    _register(manager, "ses_w", tmp_path)
    manager.record_toast("ses_w", "Stop", "Your turn")

    manager._wipe_session_state("ses_w")

    assert manager._toast_inbox.has("ses_w") is False
    assert manager._toast_inbox.get("ses_w") == []
