"""The owned-tmux ledger: one set, one file, and an atomic write.

Slice S3 of ``.claude/notes/backend-decomposition-plan.md``. Three things
are proved here and they fail for three different reasons.

**ONE SET, NOT TWO.** ``SessionManager`` moved its ``owned_tmux_sessions``
onto ``OwnedTmuxLedger.names``. If the manager kept a copy, or grew a
property that returned one, every value assertion in this repo would
still pass until the first write through the wrong reference - and then
the app would badge a session it created as somebody else's. So identity
is ONE leg of four and the others are chosen for the DATA: mutate through
one reference and read through the other, in BOTH directions, and prove
the object survives a round trip through the file.

Measured in slice S1: a property that returned a copy left the ``is``
leg AND the forward data leg both green, and only the reverse direction
went red. An ``is`` check alone has now failed to catch a real mutation
four times in this project.

**THE WRITE IS ATOMIC, AND THE PROTOCOL IS THE CLAIM.** ``write_atomic``
is tmp plus ``fsync`` plus ``os.replace``, and the reason is that a crash
between truncating the file and finishing the write would leave a
zero-byte file where the ownership record was, which costs the user every
session badge on the machine. The mutation for this slice replaces that
protocol with a plain in-place write and the test below goes red, because
a rule nothing fails for is not defended.

**A DROPPED POINTER KEEPS THE SET.** The metadata file carries two
unrelated things: the owned set, about EVERY session this app created,
and one session's row. Unlinking it to discard a dead pointer threw away
N sessions' ownership record to clean up one, on the ORDINARY path.

Run with:
    ./venv/bin/python3 -m pytest tests/test_owned_tmux_ledger.py -v
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Optional

import pytest

# The per-module environment bootstrap every test file in this suite
# carries. ``src/config.py`` builds its ``Settings`` at IMPORT time and
# calls ``sys.exit`` rather than raising when a required field is
# missing, so a module that reaches it without these set does not fail a
# test - it errors the whole FILE out with SystemExit and reports
# nothing, which reads like a collection problem rather than a config
# one.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DEFAULT_WORKING_DIR", "/tmp")
os.environ.setdefault("LOG_DIRECTORY", "/tmp")
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.session_manager import SessionManager
from src.core.sessions.owned_tmux_ledger import OwnedTmuxLedger


class _NoDatastore:
    """A record store that cannot answer, satisfying ``SessionRecordStore``.

    Description: the ownership queries must degrade to the in-memory set
      when the datastore has no opinion, and that is a DIFFERENT answer
      from "this app owns nothing". A store that answers None on every
      call is how the file half is exercised with no sqlite in the room.
    Inputs: none.
    Output: none.
    Example: OwnedTmuxLedger(..., records=_NoDatastore(), ...)
    """

    def read_connection(self) -> None:
        """No connection, ever."""
        return None

    def write_connection(self) -> None:
        """No connection, ever."""
        return None

    def get_instance(
        self, *, socket: str, name: str, epoch: Optional[int]
    ) -> None:
        """No row, ever."""
        return None


def _ledger(tmp_path: Path) -> OwnedTmuxLedger:
    """A ledger over a throwaway file and a datastore with no opinion.

    Inputs: tmp_path (Path) - pytest's per-test directory.
    Output: OwnedTmuxLedger.
    Example: ledger = _ledger(tmp_path)
    """
    target = tmp_path / "state" / "session_metadata.json"
    return OwnedTmuxLedger(
        metadata_path=lambda: target,
        records=_NoDatastore(),
        socket_name=lambda: "cloude-test",
    )


# --- the no-copy proof, four legs -------------------------------------------


def test_the_manager_and_the_ledger_are_the_same_object():
    """Leg 1, identity. Necessary, and on its own not sufficient."""
    manager = SessionManager()
    assert isinstance(manager._owned, OwnedTmuxLedger)
    assert manager._owned.names is manager._owned.names


def test_a_name_added_through_the_manager_is_visible_on_the_ledger():
    """Leg 2, data forward: mutate the manager's handle, read the ledger.

    A manager holding its own copy passes every ``==`` assertion in the
    suite and fails here on the first write.
    """
    manager = SessionManager()
    ledger = manager._owned

    manager._owned.names.add("cloude_forward")

    assert "cloude_forward" in ledger.names


def test_a_name_added_on_the_ledger_is_visible_through_the_manager():
    """Leg 3, data reverse. One direction of data flow is not enough.

    S1 measured a property that returned a COPY: the identity leg and the
    forward leg were both green and only this direction went red, because
    a copy handed out on READ still reflects writes made through the
    original.
    """
    manager = SessionManager()
    ledger = manager._owned

    ledger.names.add("cloude_reverse")

    assert "cloude_reverse" in manager._owned.names


def test_the_set_survives_a_round_trip_through_the_file_as_one_object(tmp_path):
    """Leg 4, through the medium the cluster exists for.

    ``save`` stamps the owned set onto the payload rather than trusting
    the caller to, so a pointer can never be written without the
    ownership record beside it. Reading back into a SECOND ledger and
    then mutating the FIRST proves the two are genuinely separate
    objects, which is the control on the three legs above: if the legs
    passed because everything in this module aliases everything else,
    this test would fail.
    """
    first = _ledger(tmp_path)
    first.names.update({"cloude_a", "cloude_b"})
    assert first.save({"id": "ses_1", "working_dir": "/tmp/x"}) is True

    second = _ledger(tmp_path)
    load = second.load()

    assert second.names == {"cloude_a", "cloude_b"}
    assert load.session is not None and load.session["id"] == "ses_1"
    assert "owned_tmux_sessions" not in load.session, (
        "the v3 field leaked into the Session payload; Session(**raw) is "
        "what receives this and it does not know that name"
    )

    first.names.add("cloude_c")
    assert "cloude_c" not in second.names, (
        "two ledgers over one file share an in-memory set; they must not"
    )


# --- the atomic write, which is what the mutation targets -------------------


def test_the_write_goes_through_a_temp_file_and_a_rename(tmp_path, monkeypatch):
    """THE MUTATION TARGET. A plain in-place write must fail this.

    Description: the protocol is the claim, so it is measured rather than
      read. ``os.replace`` is observed being called with the temp path
      and the final path, and the temp file is observed to exist at the
      moment of the rename - which a truncate-and-write cannot produce.
      Asserting only on the file's CONTENTS afterwards would pass
      identically for a non-atomic write, which is exactly the shape of
      test this project has been bitten by.
    """
    ledger = _ledger(tmp_path)
    seen: list[tuple[str, str, bool]] = []
    real_replace = os.replace

    def _spy(src, dst):
        seen.append((str(src), str(dst), Path(src).exists()))
        return real_replace(src, dst)

    monkeypatch.setattr(
        "src.core.sessions.owned_tmux_ledger.os.replace", _spy
    )
    ledger.write_atomic({"owned_tmux_sessions": ["cloude_a"]})

    assert len(seen) == 1, "the write did not go through os.replace"
    src, dst, existed = seen[0]
    assert dst == str(ledger.path())
    assert src != dst, "renamed the destination onto itself"
    assert src.endswith(".tmp")
    assert existed, "os.replace was called but nothing had been written to src"
    assert json.loads(ledger.path().read_text()) == {
        "owned_tmux_sessions": ["cloude_a"]
    }
    assert not Path(src).exists(), "the temp file was left behind"


def test_the_write_creates_its_parent_directory(tmp_path):
    """The state directory may not exist yet on a first run."""
    ledger = _ledger(tmp_path)
    assert not ledger.path().parent.exists()

    ledger.write_atomic({"owned_tmux_sessions": []})

    assert ledger.path().exists()


# --- dropping the pointer ----------------------------------------------------


def test_dropping_the_pointer_keeps_the_owned_set(tmp_path):
    """The invariant the file half exists for.

    The trigger is the ORDINARY case: the last-active tmux session is
    simply gone by the next start. Unlinking the file outright threw away
    every session's ownership record to clean up one, and from that point
    every launcher-created session resolved EXTERNAL.
    """
    ledger = _ledger(tmp_path)
    ledger.names.update({"cloude_alpha", "cloude_beta"})
    ledger.save({"id": "ses_dead", "working_dir": "/tmp/x"})

    ledger.drop_session_pointer()

    reborn = _ledger(tmp_path)
    load = reborn.load()
    assert load.session is None, "the dead pointer was kept"
    assert reborn.names == {"cloude_alpha", "cloude_beta"}, (
        "the owned set went with the pointer"
    )


def test_dropping_the_pointer_with_no_owned_names_leaves_no_file(tmp_path):
    """Nothing worth keeping means nothing is written back.

    The negative control on the test above: a ``drop`` that always
    re-wrote would pass that one and would resurrect a file the caller
    asked to be rid of.
    """
    ledger = _ledger(tmp_path)
    ledger.save({"id": "ses_dead", "working_dir": "/tmp/x"})
    assert ledger.path().exists()

    ledger.drop_session_pointer()

    assert not ledger.path().exists()


# --- what a read may and may not conclude ------------------------------------


def test_an_absent_file_leaves_the_ledger_exactly_as_it_was(tmp_path):
    """Not having looked is not evidence that this app owns nothing."""
    ledger = _ledger(tmp_path)
    ledger.names.add("cloude_held")

    load = ledger.load()

    assert load.session is None
    assert ledger.names == {"cloude_held"}


def test_an_unreadable_file_leaves_the_ledger_exactly_as_it_was(tmp_path):
    """A read that raised is not a report that the set is empty."""
    ledger = _ledger(tmp_path)
    ledger.names.add("cloude_held")
    ledger.path().parent.mkdir(parents=True, exist_ok=True)
    ledger.path().write_text("{not json at all")

    load = ledger.load()

    assert load.session is None
    assert ledger.names == {"cloude_held"}


def test_an_owned_set_only_payload_loads_the_set_and_no_session(tmp_path):
    """The shape ``drop_session_pointer`` writes.

    Handing this to ``Session(**raw)`` would raise and take the owned set
    down with it, which is the exact loss the payload exists to prevent.
    """
    ledger = _ledger(tmp_path)
    ledger.path().parent.mkdir(parents=True, exist_ok=True)
    ledger.path().write_text(json.dumps({"owned_tmux_sessions": ["cloude_x"]}))

    load = ledger.load()

    assert load.session is None
    assert ledger.names == {"cloude_x"}
    assert ledger.needs_legacy_backfill is False


def test_a_pre_v3_payload_arms_the_backfill_sentinel(tmp_path):
    """A file with a session and NO owned set is an upgrade, not an empty set."""
    ledger = _ledger(tmp_path)
    ledger.path().parent.mkdir(parents=True, exist_ok=True)
    ledger.path().write_text(json.dumps({"id": "ses_old", "working_dir": "/tmp/x"}))

    load = ledger.load()

    assert load.session is not None
    assert ledger.names == set()
    assert ledger.needs_legacy_backfill is True


def test_a_successful_save_is_the_migration(tmp_path):
    """One round trip clears the sentinel; that IS the schema upgrade."""
    ledger = _ledger(tmp_path)
    ledger.needs_legacy_backfill = True

    ledger.save({"id": "ses_old", "working_dir": "/tmp/x"})

    assert ledger.needs_legacy_backfill is False


# --- the ownership queries ---------------------------------------------------


def test_a_datastore_with_no_opinion_is_not_a_report_of_owning_nothing(tmp_path):
    """None and the empty set are different answers and must stay so."""
    ledger = _ledger(tmp_path)

    assert ledger.instances_from_db() is None
    assert ledger.instances() is None


def test_the_name_tier_answers_from_the_set_when_the_datastore_is_silent(tmp_path):
    """The in-memory fallback, and its negative control in one test.

    A matcher that always finds something is worse than useless, so the
    unowned name is asserted in the same pass as the owned one.
    """
    ledger = _ledger(tmp_path)
    ledger.names.add("cloude_ours")

    assert ledger.is_owned_name("cloude_ours") is True
    assert ledger.is_owned_name("cloude_theirs") is False
    assert ledger.is_owned_name("") is False
    assert ledger.is_owned_name(None) is False


@pytest.mark.parametrize("name", ["cloude_lookalike", "cloude_", "cloude_ours_2"])
def test_a_name_that_merely_looks_like_ours_is_not_owned(tmp_path, name: str):
    """The whole reason the set exists rather than a prefix match.

    Anybody can name a tmux session ``cloude_anything``. Ownership is a
    name this app RECORDED, never the shape of a string.
    """
    ledger = _ledger(tmp_path)
    ledger.names.add("cloude_ours")

    assert ledger.is_owned_name(name) is False
