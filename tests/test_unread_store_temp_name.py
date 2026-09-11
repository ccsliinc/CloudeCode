"""The unread store's temp file is named uniquely per write.

WHY THIS FILE EXISTS. ``UnreadStore._save`` built its temp file as
``<path>.tmp`` - one fixed name shared by every writer of the store.
``os.replace`` makes the swap ATOMIC and says nothing about SERIALIZED:
two writers streaming into that one shared name produce a single
interleaved document, and the rename then publishes it. That is the
defect ``src/core/config_writer.py`` was written to end for config.json,
described in CLAUDE.md under "ATOMIC AND SERIALIZED ARE DIFFERENT
PROPERTIES, AND THIS ONLY HAD THE FIRST", and this store carried the
same shape.

IT WAS NOT REACHABLE WHEN THIS TEST WAS WRITTEN, and saying so is the
point of the paragraph. All five writers (the ``Stop`` hook branch, the
manual mark-unread control, the listing pass's transcript turn-end
claim, the WebSocket view-clear and the boot prune) run on the single
uvicorn event loop, and ``_save`` contains no ``await``, so two of them
cannot interleave today. The pending move of the listing pass into a
worker thread is what would end that, which is exactly when a test
nobody wrote is the one that was needed.

THE TEMP NAME IS OBSERVED, NEVER READ OUT OF THE IMPLEMENTATION. Every
assertion here records the path ``os.replace`` was actually handed. A
test that imported the module's own format string would agree with that
string whatever it said, including a fixed one.

Run with:
    venv/bin/python3 -m pytest tests/test_unread_store_temp_name.py -v
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, List

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_ustn_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_ustn_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core import unread_store as unread_store_module
from src.core.unread_store import UnreadStore

# The name the store used to build, reproduced inline so this file fails
# if the old behaviour comes back rather than only checking that SOME
# name was chosen. Same discipline as
# tests/test_listing_liveness_socket_scope.py.
LEGACY_FIXED_NAME = "unread_state.json.tmp"


def _record_replaces(monkeypatch: pytest.MonkeyPatch) -> List[str]:
    """Capture the source path of every ``os.replace`` the store performs.

    Description: patches the name ``src.core.unread_store`` resolves, so
      what is recorded is the temp path the store REALLY renamed from,
      not a path re-derived by the test. Delegates to the real
      ``os.replace`` so the write still happens and the on-disk result
      stays assertable.
    Inputs: monkeypatch (pytest.MonkeyPatch).
    Output: list[str] - appended to in call order.
    Example: seen = _record_replaces(monkeypatch); store.set_flag(...)
    """
    seen: List[str] = []
    real_replace = os.replace

    def _spy(src: Any, dst: Any) -> None:
        """Record the temp path, then perform the real atomic rename."""
        seen.append(str(src))
        real_replace(src, dst)

    monkeypatch.setattr(unread_store_module.os, "replace", _spy)
    return seen


def test_two_writes_use_two_distinct_temp_paths(tmp_path, monkeypatch):
    """THE NEGATIVE CONTROL. A fixed temp name makes these two equal.

    This is the assertion that goes red if ``_unique_tmp_path`` is
    reverted to ``path.with_suffix(path.suffix + ".tmp")``: both writes
    then rename from the same string and the set collapses to one entry.
    """
    path = tmp_path / "unread_state.json"
    seen = _record_replaces(monkeypatch)
    store = UnreadStore(path)

    store.set_flag("cloude_a", "auto", True, epoch=5)
    store.set_flag("cloude_b", "auto", True, epoch=6)

    assert len(seen) == 2, "both writes must have gone through os.replace"
    assert len(set(seen)) == 2, (
        "two writes reused one temp filename; two writers streaming into "
        f"one file publish an interleaved document. Observed: {seen}"
    )


def test_no_write_uses_the_legacy_fixed_temp_name(tmp_path, monkeypatch):
    """The second half of the negative control, stated as the old name.

    A uniqueness assertion alone would still pass a scheme that happened
    to be unique per call and identical across PROCESSES. Naming the
    pre-fix string is what pins the specific regression.
    """
    path = tmp_path / "unread_state.json"
    seen = _record_replaces(monkeypatch)
    store = UnreadStore(path)

    store.set_flag("cloude_a", "auto", True, epoch=5)
    store.clear("cloude_a", 5)

    assert seen, "the fixture recorded no write at all"
    for observed in seen:
        assert Path(observed).name != LEGACY_FIXED_NAME, (
            "the store is back on the shared fixed temp name"
        )


def test_two_stores_on_one_path_do_not_share_a_temp_name(tmp_path, monkeypatch):
    """Two live instances of the store are two writers of one file.

    ``SessionManager`` owns one, but nothing in the module enforces that,
    and the pid half of the name is identical for both - so this is what
    proves the random half is doing the work.
    """
    path = tmp_path / "unread_state.json"
    seen = _record_replaces(monkeypatch)

    UnreadStore(path).set_flag("cloude_a", "auto", True, epoch=5)
    UnreadStore(path).set_flag("cloude_b", "auto", True, epoch=6)

    assert len(set(seen)) == 2, f"two instances shared a temp path: {seen}"


def test_the_temp_file_is_a_sibling_of_the_target(tmp_path, monkeypatch):
    """``os.replace`` is atomic only within one filesystem.

    A temp file placed anywhere but the target's own directory can land
    on a different mount, where the rename is a copy and is not atomic.
    """
    path = tmp_path / "unread_state.json"
    seen = _record_replaces(monkeypatch)
    UnreadStore(path).set_flag("cloude_a", "auto", True, epoch=5)

    assert Path(seen[0]).parent == path.parent


def test_the_written_file_is_valid_complete_json(tmp_path):
    """The rename still publishes a whole, parseable document.

    A uniqueness fix that broke the write would pass every assertion
    above, so the content is checked on its own terms and read back
    through a second store rather than only parsed.
    """
    path = tmp_path / "unread_state.json"
    store = UnreadStore(path)
    store.set_flag("cloude_a", "auto", True, epoch=5)
    store.set_flag("cloude_b", "manual", True, epoch=6)

    on_disk = json.loads(path.read_text())
    assert on_disk == {
        "cloude_a@5": {"auto": True, "manual": False},
        "cloude_b@6": {"auto": False, "manual": True},
    }

    reloaded = UnreadStore(path)
    assert reloaded.is_unread("cloude_a", 5) is True
    assert reloaded.is_unread("cloude_b", 6) is True


def test_a_successful_write_leaves_no_temp_file_behind(tmp_path):
    """The rename consumes the temp file; nothing else may remain."""
    path = tmp_path / "unread_state.json"
    store = UnreadStore(path)
    store.set_flag("cloude_a", "auto", True, epoch=5)
    store.set_flag("cloude_a", "manual", True, epoch=5)

    assert list(tmp_path.iterdir()) == [path]


def test_a_failed_write_leaves_no_orphan_temp_file(tmp_path):
    """The cost a UNIQUE name adds, and why cleanup is now required.

    A fixed temp name self-limited to one orphan that the next write
    overwrote. A unique one would drop a fresh corpse into the state
    directory on every failure, so ``_save`` unlinks it. The failure is
    induced by putting a value ``json.dump`` cannot serialise into the
    store, which fails midway through writing the temp file - the real
    shape, not a patched-out write.
    """
    path = tmp_path / "unread_state.json"
    store = UnreadStore(path)
    store.set_flag("cloude_a", "auto", True, epoch=5)
    good_bytes = path.read_text()

    # Not reachable through the public API, which is the point: this
    # exercises the failure branch of _save without mocking the write.
    store.raw["cloude_bad"] = {"auto": object(), "manual": False}
    store._save()

    leftovers = [p.name for p in tmp_path.iterdir() if p.name != path.name]
    assert leftovers == [], f"failed write left temp files behind: {leftovers}"
    assert path.read_text() == good_bytes, (
        "a failed write must leave the previous document untouched"
    )
    # The ``_save()`` above not raising is the other half of this test:
    # it is called from the hook route and the WebSocket bind, neither of
    # which may die over a cache file. A separate test asserting that
    # would assert what this one already had to survive.
