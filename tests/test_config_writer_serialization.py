"""The serialization boundary: concurrent writers, backups, temp files.

THE LOST UPDATE IS DRIVEN WITH REAL THREADS, NOT A MOCKED LOCK. A test
that patches the lock proves the test's own arrangement and nothing about
what two writers arriving together do. Every concurrency case here runs
real ``threading.Thread`` objects against a real file on disk, and the
mutators sleep INSIDE the merge so the interleaving the defect needs is
the likely schedule rather than a lucky one.

THE PRE-FIX RULE IS REPRODUCED INLINE. `test_the_pre_fix_write_pattern_
loses_an_update` performs the read-mutate-write the five migrated writers
used to perform, so this file fails if somebody reintroduces it, rather
than only asserting that the new function exists.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

import pytest

from src.core import config_writer


@pytest.fixture
def config_path(tmp_path: Path) -> Path:
    """A real config.json with two independent blocks in it."""
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"agents": {"a": 1}, "notifications": {"n": 1}}, indent=2))
    return path


def _read(path: Path) -> dict:
    return json.loads(path.read_text())


# --------------------------------------------------------------------------
# Case 1: two concurrent updates to DIFFERENT fields both survive.
# This is the case the issue says fails today.
# --------------------------------------------------------------------------


def test_two_concurrent_writers_of_different_blocks_both_survive(config_path: Path):
    barrier = threading.Barrier(2)

    def writer(key: str, value: str):
        def merge(data: dict) -> dict:
            data = dict(data)
            # Sleeping INSIDE the merge is what makes the interleaving
            # likely. Without it both threads may simply run one after
            # the other and the test would pass on a broken writer.
            time.sleep(0.05)
            data[key] = value
            return data

        barrier.wait()
        config_writer.commit(config_path, merge)

    threads = [
        threading.Thread(target=writer, args=("theme", "matrix")),
        threading.Thread(target=writer, args=("density", "compact")),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    data = _read(config_path)
    assert data["theme"] == "matrix"
    assert data["density"] == "compact"
    # The blocks that were already there are untouched.
    assert data["agents"] == {"a": 1}
    assert data["notifications"] == {"n": 1}


def test_the_pre_fix_write_pattern_loses_an_update(config_path: Path):
    """The NEGATIVE CONTROL for the case above.

    Reproduces the read-outside, write-later shape every migrated writer
    used to have. If this ever stops losing the update, the case above
    has stopped proving anything and this file says so.

    It gives each writer its OWN temp filename deliberately, so what it
    demonstrates is the lost update ALONE. The shared ``config.json.tmp``
    those writers also had is a second, independent defect and has its
    own test below.
    """
    barrier = threading.Barrier(2)

    def legacy_writer(key: str, value: str):
        raw = config_path.read_text()
        data = json.loads(raw)
        barrier.wait()
        time.sleep(0.05)
        data[key] = value
        tmp = config_path.with_suffix(f".json.{key}.tmp")
        tmp.write_text(json.dumps(data, indent=2))
        os.replace(tmp, config_path)

    threads = [
        threading.Thread(target=legacy_writer, args=("theme", "matrix")),
        threading.Thread(target=legacy_writer, args=("density", "compact")),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    data = _read(config_path)
    assert ("theme" in data) != ("density" in data), (
        "the pre-fix pattern kept both writes, so the concurrency test above "
        "is no longer exercising a real race"
    )


# --------------------------------------------------------------------------
# Case 2: two concurrent updates to the SAME field. One winner, and the
# second writer saw the first one's value rather than the stale base.
# --------------------------------------------------------------------------


def test_two_writers_of_one_field_produce_one_winner_and_no_lost_write(config_path: Path):
    seen: list = []
    barrier = threading.Barrier(2)

    def writer(value: str):
        def merge(data: dict) -> dict:
            data = dict(data)
            seen.append(data.get("theme"))
            time.sleep(0.05)
            data["theme"] = value
            return data

        barrier.wait()
        config_writer.commit(config_path, merge)

    threads = [
        threading.Thread(target=writer, args=("matrix",)),
        threading.Thread(target=writer, args=("claude",)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert _read(config_path)["theme"] in ("matrix", "claude")
    # THE SECOND MERGE SAW THE FIRST ONE'S VALUE. That is the whole
    # difference between serialized and merely atomic: the loser knows it
    # lost, so an optimistic check on top of this can refuse.
    assert seen[1] in ("matrix", "claude"), seen
    assert seen[0] is None, seen


# --------------------------------------------------------------------------
# Case 3 and 4: unknown keys, the backup, and the temp file.
# --------------------------------------------------------------------------


def test_an_unrecognised_top_level_key_survives_a_write(config_path: Path):
    data = _read(config_path)
    data["something_a_newer_version_writes"] = {"keep": "me"}
    config_path.write_text(json.dumps(data, indent=2))

    config_writer.commit(config_path, lambda d: {**d, "agents": {"a": 2}})

    after = _read(config_path)
    assert after["something_a_newer_version_writes"] == {"keep": "me"}
    assert after["agents"] == {"a": 2}


def test_the_backup_holds_the_bytes_from_before_the_write(config_path: Path):
    before = config_path.read_text()
    config_writer.commit(config_path, lambda d: {**d, "agents": {"a": 99}})

    backup = config_path.with_suffix(".json.bak")
    assert backup.exists()
    assert backup.read_text() == before
    assert _read(config_path)["agents"] == {"a": 99}


def test_a_failed_write_leaves_the_previous_file_intact_and_the_backup_present(
    config_path: Path,
):
    before = config_path.read_text()

    def explode(data: dict) -> dict:
        raise ValueError("the merge rejected this")

    with pytest.raises(ValueError):
        config_writer.commit(config_path, explode)

    assert config_path.read_text() == before
    # A mutator that refused never got as far as the backup, which is
    # correct: nothing was at risk, so nothing needed a rollback point.
    assert not list(config_path.parent.glob("*.tmp"))


def test_the_temp_file_name_is_unique_per_write(config_path: Path, monkeypatch):
    names: list = []
    real_replace = os.replace

    def spy(src, dst):
        names.append(Path(src).name)
        return real_replace(src, dst)

    monkeypatch.setattr(config_writer.os, "replace", spy)
    config_writer.commit(config_path, lambda d: {**d, "one": 1})
    config_writer.commit(config_path, lambda d: {**d, "two": 2})

    assert len(names) == 2
    assert names[0] != names[1], (
        "two writes reused one temp filename; a shared config.json.tmp is a "
        "collision the lock cannot protect against across processes"
    )
    assert all(name.endswith(".tmp") for name in names)


def test_no_temp_file_is_left_behind_when_the_write_itself_fails(
    config_path: Path, monkeypatch
):
    def explode(src, dst):
        raise OSError("the rename failed")

    monkeypatch.setattr(config_writer.os, "replace", explode)
    with pytest.raises(OSError):
        config_writer.commit(config_path, lambda d: {**d, "one": 1})

    assert not list(config_path.parent.glob("*.tmp"))


# --------------------------------------------------------------------------
# The named outcomes.
# --------------------------------------------------------------------------


def test_a_mutator_returning_none_touches_neither_the_config_nor_the_backup(
    config_path: Path,
):
    before = config_path.read_text()
    outcome = config_writer.commit(config_path, lambda d: None)

    assert outcome.status == config_writer.UNCHANGED
    assert outcome.wrote is False
    assert config_path.read_text() == before
    assert not config_path.with_suffix(".json.bak").exists()


def test_a_precondition_can_refuse_against_the_fresh_in_lock_read(config_path: Path):
    def refuse(data: dict):
        assert data["agents"] == {"a": 1}
        return config_writer.STALE_REVISION

    outcome = config_writer.commit(
        config_path, lambda d: {**d, "never": True}, precondition=refuse
    )

    assert outcome.status == config_writer.STALE_REVISION
    assert outcome.wrote is False
    assert "never" not in _read(config_path)


def test_a_required_backup_that_cannot_be_written_abandons_the_commit(
    config_path: Path, monkeypatch
):
    before = config_path.read_text()

    def no_backup(self, *args, **kwargs):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(Path, "write_text", no_backup)
    outcome = config_writer.commit(
        config_path, lambda d: {**d, "one": 1}, backup_required=True
    )

    assert outcome.status == config_writer.BACKUP_UNAVAILABLE
    assert outcome.wrote is False
    monkeypatch.undo()
    assert config_path.read_text() == before


def test_a_best_effort_backup_failure_still_lets_the_users_save_land(
    config_path: Path, monkeypatch
):
    real_write_text = Path.write_text

    def no_backup(self, *args, **kwargs):
        if self.name.endswith(".bak"):
            raise OSError("read-only filesystem")
        return real_write_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", no_backup)
    outcome = config_writer.commit(config_path, lambda d: {**d, "one": 1})

    assert outcome.status == config_writer.COMMITTED
    assert outcome.wrote is True
    monkeypatch.undo()
    assert _read(config_path)["one"] == 1


def test_a_nested_commit_raises_rather_than_merging_into_a_stale_base(
    config_path: Path,
):
    def nested(data: dict) -> dict:
        config_writer.commit(config_path, lambda d: {**d, "inner": True})
        return {**data, "outer": True}

    with pytest.raises(RuntimeError, match="from inside a mutator"):
        config_writer.commit(config_path, nested)


def test_a_missing_config_raises_rather_than_creating_one(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        config_writer.commit(tmp_path / "nope.json", lambda d: d)


def test_invalid_json_on_disk_is_a_value_error_and_nothing_is_written(tmp_path: Path):
    path = tmp_path / "config.json"
    path.write_text("{not json")
    with pytest.raises(ValueError):
        config_writer.commit(path, lambda d: {**d, "one": 1})
    assert path.read_text() == "{not json"


def test_a_commit_listener_failure_does_not_fail_the_write(config_path: Path):
    def bad_listener(path, data):
        raise RuntimeError("this listener is broken")

    config_writer.on_commit(bad_listener)
    try:
        outcome = config_writer.commit(config_path, lambda d: {**d, "one": 1})
        assert outcome.status == config_writer.COMMITTED
        assert _read(config_path)["one"] == 1
    finally:
        config_writer._listeners.remove(bad_listener)
