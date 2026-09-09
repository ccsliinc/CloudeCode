"""A terminal bind must clear the SAME instance key the writers wrote.

THE SEQUENCE THESE TESTS ENCODE is the one measured in the browser on
2026-09-08: mark a running session unread from the card, then open its
tab, and read ``/sessions/list``. The flag survived. The owner's rule,
verbatim: "when clicking a tab, the session is marked read. if i want it
unread i click unread."

The load-bearing case is the RESTART one. ``_instance_epochs`` is keyed
by session_id and seeded from the create / adopt / boot-readopt paths, so
it is empty for every session that predates the current process - which
after any restart is all of them - and what it holds otherwise came from
a DATABASE ROW rather than from tmux. While the set and the clear derived
their epochs from two different places, a clear could compose a key
nobody had written and the flag became unclearable for the life of the
session, with every layer in between reading correct.

The negative controls are mandatory and are the reason to trust the rest:
a clear aimed at a DIFFERENT tmux name must not touch this one, and a
clear that "worked" by dropping every entry in the store would pass every
positive assertion here.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.core import unread_identity
from src.core.unread_store import UnreadStore


# --------------------------------------------------------------------------
# doubles
# --------------------------------------------------------------------------


class FakeListing:
    """The two fields ``unread_identity`` reads off a tmux listing."""

    def __init__(self, rows, ok: bool = True) -> None:
        self.ok = ok
        self.sessions = rows


def listing_of(*pairs, ok: bool = True) -> FakeListing:
    """A tmux listing carrying ``(name, epoch)`` pairs."""
    return FakeListing(
        [{"name": n, "created_at_epoch": e} for n, e in pairs], ok=ok
    )


@pytest.fixture()
def store(tmp_path: Path) -> UnreadStore:
    return UnreadStore(tmp_path / "unread_state.json")


NAME = "cloude_Fantasy_Hockey_2026"
OTHER = "cloude_Hirschfeld"
EPOCH = 1788444912
OTHER_EPOCH = 1788463221


# --------------------------------------------------------------------------
# the measured sequence
# --------------------------------------------------------------------------


def test_manual_mark_then_bind_then_list_reads_read(store: UnreadStore) -> None:
    """mark unread -> WS bind -> the list says read."""
    cache: dict[str, int] = {}
    probe = lambda: listing_of((NAME, EPOCH), (OTHER, OTHER_EPOCH))

    # 1. the user's control.
    store.set_flag(
        NAME, "manual", True,
        epoch=unread_identity.resolve_epoch(cache, NAME, probe),
    )
    assert store.is_unread(NAME, unread_identity.resolve_epoch(cache, NAME, probe))

    # 2. a WS terminal binds - SessionManager.mark_session_viewed.
    store.clear(NAME, unread_identity.resolve_epoch(cache, NAME, probe))

    # 3. what GET /sessions/list reports.
    assert store.is_unread(NAME, unread_identity.resolve_epoch(cache, NAME, probe)) is False


def test_stop_sets_it_again_and_a_second_bind_clears_it(store: UnreadStore) -> None:
    """Stop -> unread; bind -> read; a duplicate bind is harmless."""
    cache: dict[str, int] = {}
    probe = lambda: listing_of((NAME, EPOCH))
    epoch = lambda: unread_identity.resolve_epoch(cache, NAME, probe)

    store.set_flag(NAME, "auto", True, epoch=epoch())
    assert store.is_unread(NAME, epoch()) is True

    store.clear(NAME, epoch())
    assert store.is_unread(NAME, epoch()) is False

    # A re-attach binds a second time. Idempotent: same file, no raise.
    store.clear(NAME, epoch())
    store.clear(NAME, epoch())
    assert store.is_unread(NAME, epoch()) is False


def test_a_bind_clears_both_sub_flags_not_just_one(store: UnreadStore) -> None:
    """A row flagged by BOTH a Stop and the control reads read after a bind.

    Clearing one half would leave the row unread and the control reading
    as dead, which is the state the owner's rule forbids.
    """
    cache: dict[str, int] = {}
    probe = lambda: listing_of((NAME, EPOCH))
    epoch = unread_identity.resolve_epoch(cache, NAME, probe)

    store.set_flag(NAME, "auto", True, epoch=epoch)
    store.set_flag(NAME, "manual", True, epoch=epoch)
    entry = store.raw[UnreadStore.compose_key(NAME, EPOCH)]
    assert entry == {"auto": True, "manual": True}

    store.clear(NAME, epoch)
    assert store.is_unread(NAME, epoch) is False
    assert UnreadStore.compose_key(NAME, EPOCH) not in store.raw


# --------------------------------------------------------------------------
# the key derivation itself - THE regression this round closes
# --------------------------------------------------------------------------


def test_set_and_clear_agree_with_an_empty_cache_after_a_restart() -> None:
    """A cold memo resolves the SAME epoch a warm one does.

    After a server restart nothing has seeded the memo, so the set spends
    a probe and the clear reads what that probe cached. Both must compose
    one key. This is the exact condition under which the old code filed
    the set under ``<name>@<epoch>`` and the clear under the bare name.
    """
    probe_calls = []

    def probe():
        probe_calls.append(1)
        return listing_of((NAME, EPOCH))

    cold: dict[str, int] = {}
    set_epoch = unread_identity.resolve_epoch(cold, NAME, probe)
    clear_epoch = unread_identity.resolve_epoch(cold, NAME, probe)

    assert set_epoch == clear_epoch == EPOCH
    assert UnreadStore.compose_key(NAME, set_epoch) == f"{NAME}@{EPOCH}"
    # The memo means the second resolve costs no probe.
    assert len(probe_calls) == 1


def test_the_row_epoch_and_the_resolver_compose_one_key() -> None:
    """The READ path seeds the memo from its listing row and agrees.

    ``_session_info_for`` holds a row already and must not spend a probe,
    so it calls ``remember`` then a memo-only ``resolve_epoch``. That has
    to reach the same key the writers' probing path reaches.
    """
    write_cache: dict[str, int] = {}
    written = unread_identity.resolve_epoch(
        write_cache, NAME, lambda: listing_of((NAME, EPOCH))
    )

    read_cache: dict[str, int] = {}
    row = {"name": NAME, "created_at_epoch": EPOCH}
    read = unread_identity.remember(
        read_cache, NAME, unread_identity.epoch_of_row(row)
    ) or unread_identity.resolve_epoch(read_cache, NAME)

    assert UnreadStore.compose_key(NAME, written) == UnreadStore.compose_key(NAME, read)


def test_an_unmeasurable_epoch_degrades_to_the_legacy_bare_name() -> None:
    """tmux cannot answer -> the legacy key, not a second entry.

    Documented in CLAUDE.md: a None epoch is UNMEASURED, never new.
    """
    cache: dict[str, int] = {}
    assert unread_identity.resolve_epoch(cache, NAME, lambda: listing_of(ok=False)) is None
    assert UnreadStore.compose_key(NAME, None) == NAME


def test_a_failed_probe_does_not_wipe_the_memo() -> None:
    """A transient tmux failure is not evidence an epoch moved."""
    cache = {NAME: EPOCH}
    unread_identity.remember_listing(cache, listing_of(ok=False))
    assert cache == {NAME: EPOCH}


def test_a_reused_tmux_name_is_re_measured_by_the_next_listing() -> None:
    """A new instance under a recycled name overwrites the memo.

    This is the reason the memo is refreshed from every listing rather
    than filled once: a name is reused, and a flag keyed on the dead
    session's epoch must not answer for the live one.
    """
    cache: dict[str, int] = {}
    unread_identity.remember_listing(cache, listing_of((NAME, EPOCH)))
    assert cache[NAME] == EPOCH
    unread_identity.remember_listing(cache, listing_of((NAME, EPOCH + 9999)))
    assert cache[NAME] == EPOCH + 9999


def test_epoch_of_row_coerces_text_and_refuses_junk() -> None:
    """tmux speaks text; junk is a cannot-determine, not a crash."""
    assert unread_identity.epoch_of_row({"created_at_epoch": "17"}) == 17
    assert unread_identity.epoch_of_row({"created_at_epoch": None}) is None
    assert unread_identity.epoch_of_row({"created_at_epoch": "not-a-number"}) is None
    assert unread_identity.epoch_of_row({}) is None
    assert unread_identity.epoch_of_row(None) is None


# --------------------------------------------------------------------------
# NEGATIVE CONTROLS - a clear that always clears would pass everything above
# --------------------------------------------------------------------------


def test_a_bind_for_a_different_session_leaves_this_flag_alone(
    store: UnreadStore,
) -> None:
    """Opening OTHER's tab must not mark THIS one read."""
    cache: dict[str, int] = {}
    probe = lambda: listing_of((NAME, EPOCH), (OTHER, OTHER_EPOCH))

    store.set_flag(NAME, "manual", True, epoch=unread_identity.resolve_epoch(cache, NAME, probe))
    store.set_flag(OTHER, "auto", True, epoch=unread_identity.resolve_epoch(cache, OTHER, probe))

    store.clear(OTHER, unread_identity.resolve_epoch(cache, OTHER, probe))

    assert store.is_unread(OTHER, unread_identity.resolve_epoch(cache, OTHER, probe)) is False
    assert store.is_unread(NAME, unread_identity.resolve_epoch(cache, NAME, probe)) is True


def test_a_bind_on_a_different_INSTANCE_of_the_same_name_does_not_clear(
    store: UnreadStore,
) -> None:
    """The key is the instance. A new session under the same name is not it.

    Without this, a clear derived from a stale epoch would look like it
    worked while the live session stayed unread - and a clear derived
    from a fresh epoch would silently mark a session read that nobody
    opened.
    """
    store.set_flag(NAME, "manual", True, epoch=EPOCH)
    store.clear(NAME, EPOCH + 5000)
    assert store.is_unread(NAME, EPOCH) is True


def test_the_clear_writes_only_this_instances_keys(tmp_path: Path) -> None:
    """The on-disk file keeps every other row verbatim."""
    path = tmp_path / "unread_state.json"
    store = UnreadStore(path)
    store.set_flag(NAME, "manual", True, epoch=EPOCH)
    store.set_flag(OTHER, "auto", True, epoch=OTHER_EPOCH)
    store.set_flag("cloude_daily-briefing", "auto", True, epoch=None)

    store.clear(NAME, EPOCH)

    on_disk = json.loads(path.read_text())
    assert set(on_disk) == {
        UnreadStore.compose_key(OTHER, OTHER_EPOCH),
        "cloude_daily-briefing",
    }
