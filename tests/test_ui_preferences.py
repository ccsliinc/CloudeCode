"""The typed block, its validation, its revision, and its projection.

THE PER-VIEWER NEGATIVE CONTROL IS THE LOAD-BEARING TEST IN THIS FILE.
Everything else here proves the block does what it says. What actually
protects a user is proving it does NOT hold the ten keys the inventory
classified as per-viewer: a sync set that quietly grew would pass every
positive test in this file perfectly and would push one device's layout
onto every other device the user owns. A preference that fails to sync is
recoverable in a second; one that overwrites another device is not.
"""

from __future__ import annotations

import builtins
import json
import threading
import time
from pathlib import Path

import pytest

from src.core import config_writer, ui_preferences
from src.core.ui_preferences_store import (
    COMMITTED,
    REJECTED_INVALID,
    STALE_REVISION,
    UNCHANGED,
    UiPreferencesStore,
)


@pytest.fixture
def config_path(tmp_path: Path) -> Path:
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"agents": {"a": 1}}, indent=2))
    return path


@pytest.fixture
def store(config_path: Path) -> UiPreferencesStore:
    return UiPreferencesStore(lambda: config_path)


def _read(path: Path) -> dict:
    return json.loads(path.read_text())


# --------------------------------------------------------------------------
# THE NEGATIVE CONTROL: what must never be in the block.
# --------------------------------------------------------------------------

# Every key the inventory put in the per-viewer column, spelled as the
# field name it WOULD take if somebody added it. Read
# docs/ui-preferences-inventory.md before touching this list; each one
# has a recorded reason it stays local.
MUST_NOT_SYNC = (
    "launchpad_deleted_sessions_visible",
    "launchpad_archived_visible",
    "status_key_open",
    "away_last_choice",
    "archive_project_order",
    "archive_panes",
    "theme_js_allowlist",
    "theme_vars",
    "audio_settings_version",
    "audio_muted",
    # The fourth AMBIGUOUS key, deliberately left out: it has no viewport
    # gate and is written on every open and close, so it records what one
    # device is doing rather than what the user prefers.
    "sidebar_open",
)


@pytest.mark.parametrize("field", MUST_NOT_SYNC)
def test_a_per_viewer_key_is_not_a_known_preference(field: str):
    assert field not in ui_preferences.known_fields(), (
        f"'{field}' was classified as per-viewer in "
        "docs/ui-preferences-inventory.md. Syncing it pushes one device's "
        "layout onto every other device. If this is a deliberate change, "
        "the inventory has to change first."
    )


def test_a_secret_can_never_be_stored_even_as_an_unknown_field(store):
    for name in ("claude_tunnel_token", "claude_refresh_token"):
        result = store.update({name: "value"})
        assert result.status == REJECTED_INVALID
        assert name not in result.values
        # The refusal never quotes what it refused.
        assert "value" not in (result.detail or "")


@pytest.mark.parametrize(
    "name", ["some_api_key", "openrouter_token", "user_password", "my_secret"]
)
def test_a_name_that_reads_like_a_credential_is_refused(store, name: str):
    assert store.update({name: "x"}).status == REJECTED_INVALID


# --------------------------------------------------------------------------
# The three ambiguous keys that ARE shared, so the decision is pinned.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "field", ["sidebar_pinned", "config_editor_pinned", "launchpad_collapsed"]
)
def test_the_three_shared_ambiguous_keys_are_known_preferences(field: str):
    assert field in ui_preferences.known_fields()


# --------------------------------------------------------------------------
# Validation.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "changes",
    [
        {"sidebar_density": "enormous"},
        {"theme": "../../etc/passwd"},
        {"audio_master_volume": 0.0},
        {"audio_master_volume": 2.0},
        {"launch_last_model": "-leading-dash"},
        {"launchpad_collapsed": {"not-a-section": True}},
        {"sidebar_arrangement": {"v": 1, "collapsed": ["nonsense"]}},
        {"sidebar_arrangement": {"v": 1, "unexpected": 1}},
    ],
)
def test_a_bad_value_is_refused_and_nothing_is_written(store, config_path, changes):
    before = config_path.read_text()
    result = store.update(changes)
    assert result.status == REJECTED_INVALID
    assert result.detail
    assert config_path.read_text() == before


@pytest.mark.parametrize(
    "changes",
    [
        {"sidebar_density": "compact"},
        {"theme": "matrix"},
        {"audio_enabled": True},
        {"audio_master_volume": 0.5},
        {"launch_last_model": ""},
        {"launch_last_model": "anthropic/claude-sonnet-4"},
        {"sidebar_pinned": True},
        {"config_editor_pinned": False},
        {"config_editor_collapsed": {"project:src": True}},
        {"launchpad_collapsed": {"recent-projects": True}},
    ],
)
def test_a_good_value_commits(store, changes):
    result = store.update(changes)
    assert result.status == COMMITTED, result.detail
    for name, value in changes.items():
        assert result.values[name] == value


def test_a_sidebar_arrangement_is_stored_as_a_complete_envelope(store):
    """A typed sub-model NORMALISES, and that is deliberate.

    The client may send a partial envelope; what is stored carries every
    key with its default filled in, so a reader never has to ask whether
    an absent ``order`` means "empty" or "this writer did not know about
    the field".
    """
    result = store.update(
        {"sidebar_arrangement": {"v": 1, "pinned": ["a"], "collapsed": ["pinned", "g:x"]}}
    )
    assert result.status == COMMITTED, result.detail
    assert result.values["sidebar_arrangement"] == {
        "v": 1,
        "pinned": ["a"],
        "order": [],
        "collapsed": ["pinned", "g:x"],
    }


def test_an_empty_change_set_is_refused(store):
    assert store.update({}).status == REJECTED_INVALID


# --------------------------------------------------------------------------
# Unknown fields, the revision, and unsetting.
# --------------------------------------------------------------------------


def test_an_unrecognised_preference_in_the_block_survives_a_write(
    store, config_path
):
    data = _read(config_path)
    data[ui_preferences.UI_PREFERENCES_KEY] = {
        "schema_version": 1,
        "revision": 4,
        "values": {"a_field_from_a_newer_client": {"deep": [1, 2]}},
    }
    config_path.write_text(json.dumps(data, indent=2))
    store.invalidate()

    result = store.update({"theme": "matrix"})

    assert result.status == COMMITTED
    assert result.values["a_field_from_a_newer_client"] == {"deep": [1, 2]}
    assert result.values["theme"] == "matrix"
    assert result.revision == 5


def test_a_newer_clients_unknown_field_can_be_written_and_read_back(store):
    result = store.update({"a_field_from_a_newer_client": "hello"})
    assert result.status == COMMITTED
    assert store.read()["values"]["a_field_from_a_newer_client"] == "hello"


def test_an_oversized_unknown_value_is_refused(store):
    huge = "x" * (ui_preferences.MAX_UNKNOWN_VALUE_BYTES + 1)
    assert store.update({"future_field": huge}).status == REJECTED_INVALID


def test_the_revision_moves_only_when_something_actually_changed(store):
    first = store.update({"theme": "matrix"})
    assert first.status == COMMITTED
    assert first.revision == 1
    assert first.changed == {"theme": "matrix"}

    again = store.update({"theme": "matrix"})
    assert again.status == UNCHANGED
    assert again.revision == 1
    assert again.changed == {}


def test_none_unsets_a_field_and_counts_as_a_change(store):
    store.update({"theme": "matrix"})
    result = store.update({"theme": None})

    assert result.status == COMMITTED
    assert "theme" not in result.values
    assert result.changed == {"theme": None}
    assert result.revision == 2


def test_changed_names_only_the_fields_that_moved(store):
    store.update({"theme": "matrix", "sidebar_density": "compact"})
    result = store.update({"theme": "matrix", "sidebar_density": "cozy"})

    assert result.status == COMMITTED
    assert result.changed == {"sidebar_density": "cozy"}


# --------------------------------------------------------------------------
# The revision check. The STALE case is what stops a lost setting.
# --------------------------------------------------------------------------


def test_a_stale_revision_write_is_refused_and_says_what_is_current(store):
    store.update({"theme": "matrix"})  # revision 1
    store.update({"sidebar_density": "compact"})  # revision 2

    result = store.update({"theme": "claude"}, expected_revision=1)

    assert result.status == STALE_REVISION
    assert result.revision == 2
    # The refusal hands back what is really stored, which is the only
    # thing a client can reconcile against.
    assert result.values["theme"] == "matrix"
    assert result.values["sidebar_density"] == "compact"
    assert store.read()["values"]["theme"] == "matrix"


def test_without_the_revision_check_the_same_write_would_have_landed(store):
    """The NEGATIVE CONTROL for the case above.

    A test that only proves a fresh write succeeds proves nothing about
    the check. This performs the IDENTICAL write with the check declined,
    and asserts it overwrites - so if the check ever stops refusing, the
    two tests disagree and the file fails.
    """
    store.update({"theme": "matrix"})
    store.update({"sidebar_density": "compact"})

    result = store.update({"theme": "claude"}, expected_revision=None)

    assert result.status == COMMITTED
    assert store.read()["values"]["theme"] == "claude"


def test_a_current_revision_is_accepted(store):
    store.update({"theme": "matrix"})
    result = store.update({"sidebar_density": "compact"}, expected_revision=1)
    assert result.status == COMMITTED
    assert result.revision == 2


def test_revision_zero_is_the_expected_revision_for_a_first_write(store):
    assert store.revision() == 0
    result = store.update({"theme": "matrix"}, expected_revision=0)
    assert result.status == COMMITTED


def test_two_concurrent_partial_updates_to_different_fields_both_survive(store):
    barrier = threading.Barrier(2)
    results: list = []

    def writer(changes):
        barrier.wait()
        time.sleep(0.02)
        results.append(store.update(changes))

    threads = [
        threading.Thread(target=writer, args=({"theme": "matrix"},)),
        threading.Thread(target=writer, args=({"sidebar_density": "compact"},)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    values = store.read()["values"]
    assert values["theme"] == "matrix"
    assert values["sidebar_density"] == "compact"
    assert store.revision() == 2
    assert all(result.status == COMMITTED for result in results)


# --------------------------------------------------------------------------
# The projection.
# --------------------------------------------------------------------------


def test_a_read_after_the_first_one_touches_no_file(store, monkeypatch):
    store.read()  # prime the projection

    def refuse(*args, **kwargs):
        raise AssertionError("a preference read opened a file")

    monkeypatch.setattr(builtins, "open", refuse)
    assert store.read()["revision"] == 0
    assert store.revision() == 0


def test_a_write_by_any_other_config_writer_refreshes_the_projection(
    store, config_path
):
    store.read()  # prime it

    # A DIFFERENT writer of config.json entirely, going through the same
    # boundary. Its commit must refresh this projection, or the store
    # would answer from a cache the file no longer agrees with.
    config_writer.commit(
        config_path,
        lambda data: {
            **data,
            ui_preferences.UI_PREFERENCES_KEY: {
                "schema_version": 1,
                "revision": 9,
                "values": {"theme": "written-by-someone-else"},
            },
        },
    )

    assert store.read()["revision"] == 9
    assert store.read()["values"]["theme"] == "written-by-someone-else"


def test_a_caller_cannot_mutate_the_projection_through_the_dict_it_is_handed(store):
    store.update({"theme": "matrix"})
    block = store.read()
    block["values"]["theme"] = "tampered"
    assert store.read()["values"]["theme"] == "matrix"


def test_a_missing_config_reads_as_nothing_set_rather_than_raising(tmp_path: Path):
    store = UiPreferencesStore(lambda: tmp_path / "absent.json")
    block = store.read()
    assert block["revision"] == 0
    assert block["values"] == {}


def test_an_unparseable_config_reads_as_nothing_set_and_invents_no_default(
    tmp_path: Path,
):
    path = tmp_path / "config.json"
    path.write_text("{not json")
    store = UiPreferencesStore(lambda: path)

    block = store.read()
    assert block["values"] == {}
    # A FAILED READ MUST NEVER LOOK LIKE A SETTING. If any field came back
    # with a fabricated value, a client would save that default over the
    # user's real one the first time it wrote anything.
    assert not any(field in block["values"] for field in ui_preferences.known_fields())


@pytest.mark.parametrize(
    "block",
    [
        {"revision": "seven", "values": {"theme": "matrix"}},
        {"revision": -1, "values": {"theme": "matrix"}},
        {"revision": True, "values": {}},
        {"values": "not an object"},
        "not an object at all",
        [],
    ],
)
def test_a_hand_edited_block_degrades_rather_than_raising(block):
    result = ui_preferences.read_block({ui_preferences.UI_PREFERENCES_KEY: block})
    assert isinstance(result["revision"], int)
    assert result["revision"] >= 0
    assert isinstance(result["values"], dict)
