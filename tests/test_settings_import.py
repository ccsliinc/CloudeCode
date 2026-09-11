"""The one-time import of a browser's settings: the preview, and the marker.

THE THREE CASES ISSUE #46 SAYS TO WRITE FIRST ARE WRITTEN FIRST HERE,
because each is a failure that looks like a success:

  1. THE PREVIEW MATCHES THE IMPORT. A preview that lies is worse than no
     preview - it is a safety control telling the user they are safe. It
     is proven by previewing, committing, and asserting that what landed
     is exactly what the preview named, rather than by reading the two
     code paths and agreeing they look similar.
  2. A SECOND BROWSER IS OFFERED NOTHING. The whole flow exists because
     an automatic migration means the last browser to connect wins: a
     machine nobody has opened in three months uploads its stale snapshot
     and silently reverts everything changed since.
  3. NO TOKEN REACHES STORAGE, asserted against what the endpoint
     actually stored and returned, not against the collector's source.

The refusal cases outnumber the happy path on purpose. An import that
always finds something to write is the same defect as a matcher that
always finds something.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_imp_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_imp_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.auth import require_auth
from src.api.settings_routes import router as settings_import_router
from src.core import settings_import, ui_preferences
from src.core.settings_import_store import SettingsImportStore


@pytest.fixture
def client(tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"agents": {"a": 1}}, indent=2))

    app = FastAPI()
    app.include_router(settings_import_router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: {"sub": "test"}
    app.state.settings_import_store = SettingsImportStore(lambda: config_path)

    with TestClient(app) as test_client:
        yield test_client, config_path


def _stored_values(config_path: Path) -> dict:
    """The preference values actually on disk."""
    return ui_preferences.read_block(json.loads(config_path.read_text()))["values"]


def _seed(config_path: Path, values: dict, revision: int = 3) -> None:
    """Put a committed preference block on disk."""
    doc = json.loads(config_path.read_text())
    doc[ui_preferences.UI_PREFERENCES_KEY] = {
        "schema_version": ui_preferences.SCHEMA_VERSION,
        "revision": revision,
        "values": values,
    }
    config_path.write_text(json.dumps(doc, indent=2))


# ---------------------------------------------------------------------
# 1. The preview matches the import.
# ---------------------------------------------------------------------


def test_the_preview_is_exactly_what_the_import_does(client):
    """Previewed, committed, compared. Not read and agreed with."""
    api, config_path = client
    _seed(config_path, {"theme": "claude", "sidebar_density": "cozy"})

    candidates = {
        # a conflict the user selects
        "theme": "matrix",
        # a conflict the user does NOT select
        "sidebar_density": "compact",
        # nothing on the server
        "audio_enabled": True,
        # already identical
        "launch_last_model": "",
        # not importable
        "theme_script_consent": {"matrix": {"decision": "always", "digest": "a" * 64}},
        # invalid
        "audio_master_volume": 9.0,
    }
    _seed(
        config_path,
        {"theme": "claude", "sidebar_density": "cozy", "launch_last_model": ""},
    )

    preview = api.post(
        "/api/v1/settings/import/preview",
        json={"candidates": candidates, "selections": ["theme"]},
    ).json()

    promised = {
        row["field"]: row["candidate"] for row in preview["fields"] if row["writes"]
    }
    assert promised == {"theme": "matrix", "audio_enabled": True}

    commit = api.post(
        "/api/v1/settings/import",
        json={"candidates": candidates, "selections": ["theme"]},
    )
    assert commit.status_code == 200
    body = commit.json()

    assert body["changed"] == promised, (
        "the import moved something the preview did not name, or did not move "
        "something it did"
    )
    stored = _stored_values(config_path)
    assert stored["theme"] == "matrix"
    assert stored["sidebar_density"] == "cozy", "an unselected conflict was overwritten"
    assert stored["audio_enabled"] is True
    assert "theme_script_consent" not in stored
    assert "audio_master_volume" not in stored

    # And the two responses describe the same plan, field for field.
    assert [row["field"] for row in body["fields"]] == [
        row["field"] for row in preview["fields"]
    ]
    assert [row["outcome"] for row in body["fields"]] == [
        row["outcome"] for row in preview["fields"]
    ]


def test_each_conflict_outcome_is_named_rather_than_implied(client):
    api, config_path = client
    _seed(config_path, {"theme": "claude", "sidebar_density": "cozy"})

    preview = api.post(
        "/api/v1/settings/import/preview",
        json={
            "candidates": {"theme": "matrix", "sidebar_density": "compact"},
            "selections": ["theme"],
        },
    ).json()
    outcomes = {row["field"]: row["outcome"] for row in preview["fields"]}
    assert outcomes["theme"] == settings_import.CONFLICT_OVERRIDDEN
    assert outcomes["sidebar_density"] == settings_import.CONFLICT_KEPT

    kept = next(r for r in preview["fields"] if r["field"] == "sidebar_density")
    assert kept["current"] == "cozy" and kept["candidate"] == "compact", (
        "the preview did not show both values, so the user cannot choose"
    )


def test_a_preview_writes_nothing(client):
    api, config_path = client
    before = config_path.read_text()
    api.post(
        "/api/v1/settings/import/preview",
        json={"candidates": {"theme": "matrix"}, "selections": ["theme"]},
    )
    assert config_path.read_text() == before


# ---------------------------------------------------------------------
# 2. The stale-browser defence.
# ---------------------------------------------------------------------


def test_a_second_browser_is_offered_nothing_after_an_import(client):
    api, config_path = client

    first = api.post(
        "/api/v1/settings/import", json={"candidates": {"theme": "matrix"}}
    )
    assert first.status_code == 200

    state = api.get("/api/v1/settings/import/state").json()
    assert state["completed"] is True
    assert state["completed_at"]

    # The three-month-old machine connects and offers its stale snapshot.
    stale = api.post(
        "/api/v1/settings/import",
        json={"candidates": {"theme": "claude"}, "selections": ["theme"]},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["status"] == settings_import.ALREADY_IMPORTED
    assert _stored_values(config_path)["theme"] == "matrix", (
        "a stale browser reseeded a shared preference after the import closed"
    )


def test_the_preview_says_so_too_rather_than_letting_the_button_fail(client):
    api, _ = client
    api.post("/api/v1/settings/import", json={"candidates": {"theme": "matrix"}})
    preview = api.post(
        "/api/v1/settings/import/preview", json={"candidates": {"theme": "claude"}}
    ).json()
    assert preview["status"] == settings_import.ALREADY_IMPORTED


def test_an_import_that_writes_nothing_still_closes_the_offer(client):
    """Everything already on the server is a completed import, not a no-op."""
    api, config_path = client
    _seed(config_path, {"theme": "matrix"})

    body = api.post(
        "/api/v1/settings/import", json={"candidates": {"theme": "matrix"}}
    ).json()
    assert body["changed"] == {}
    assert api.get("/api/v1/settings/import/state").json()["completed"] is True


def test_the_marker_and_the_values_land_in_one_write(client):
    api, config_path = client
    api.post("/api/v1/settings/import", json={"candidates": {"theme": "matrix"}})
    doc = json.loads(config_path.read_text())
    assert settings_import.is_completed(doc)
    assert doc[ui_preferences.UI_PREFERENCES_KEY]["values"]["theme"] == "matrix"
    assert doc[settings_import.IMPORT_MARKER_KEY]["fields"] == ["theme"]


# ---------------------------------------------------------------------
# 3. Nothing that is not a preference can get in.
# ---------------------------------------------------------------------


def test_a_token_in_the_payload_is_never_stored_and_never_echoed(client):
    """Asserted against what the endpoint stored and returned.

    The client-side guarantee (a token is never COLLECTED) is proven in
    tests/test_settings_import_collect.node.mjs against the outgoing
    request body. This is the other end of it: even a client that sent
    one gets it refused rather than stored.
    """
    api, config_path = client
    secret = "tok_do_not_store_me_0123456789"
    response = api.post(
        "/api/v1/settings/import",
        json={
            "candidates": {
                "theme": "matrix",
                "claude_tunnel_token": secret,
                "claude_refresh_token": secret,
            }
        },
    )
    assert response.status_code == 200

    on_disk = config_path.read_text()
    assert secret not in on_disk
    assert "claude_tunnel_token" not in _stored_values(config_path)
    assert "claude_refresh_token" not in _stored_values(config_path)

    body = response.text
    assert secret not in body, "the refusal echoed the value it refused"
    outcomes = {row["field"]: row["outcome"] for row in response.json()["fields"]}
    assert outcomes["claude_tunnel_token"] == settings_import.REFUSED


def test_theme_script_consent_is_refused_by_name(client):
    """Never infer, and never carry, a theme script approval.

    A browser's local record names a theme id and no digest, so importing
    it would mint the unbounded standing grant #45 exists to make
    unexpressible.
    """
    api, config_path = client
    response = api.post(
        "/api/v1/settings/import",
        json={
            "candidates": {
                "theme": "matrix",
                "theme_script_consent": {
                    "matrix": {"decision": "always", "digest": "a" * 64}
                },
            }
        },
    )
    assert response.status_code == 200
    assert "theme_script_consent" not in _stored_values(config_path)
    row = next(
        r for r in response.json()["fields"] if r["field"] == "theme_script_consent"
    )
    assert row["outcome"] == settings_import.REFUSED
    assert row["writes"] is False
    assert "theme_script_consent" not in settings_import.importable_fields()


def test_importing_a_theme_choice_grants_no_script_consent(client):
    api, config_path = client
    api.post("/api/v1/settings/import", json={"candidates": {"theme": "matrix"}})
    stored = _stored_values(config_path)
    assert stored["theme"] == "matrix"
    assert "theme_script_consent" not in stored


def test_an_unrecognised_field_is_refused_rather_than_stored(client):
    """The preference block PRESERVES unknown fields; an import does not.

    Those are two different promises. Preserving one a newer client wrote
    is data-loss protection; accepting one from a browser snapshot is an
    allowlist with a hole in it.
    """
    api, config_path = client
    response = api.post(
        "/api/v1/settings/import",
        json={"candidates": {"something_new": "value"}},
    )
    assert response.status_code == 200
    assert "something_new" not in _stored_values(config_path)


def test_an_invalid_value_refuses_only_itself(client):
    api, config_path = client
    response = api.post(
        "/api/v1/settings/import",
        json={"candidates": {"theme": "matrix", "sidebar_density": "enormous"}},
    )
    assert response.status_code == 200
    stored = _stored_values(config_path)
    assert stored["theme"] == "matrix"
    assert "sidebar_density" not in stored
    outcomes = {row["field"]: row["outcome"] for row in response.json()["fields"]}
    assert outcomes["sidebar_density"] == settings_import.REJECTED_INVALID


def test_an_import_may_add_or_replace_but_never_clear(client):
    api, config_path = client
    _seed(config_path, {"theme": "matrix"})
    response = api.post(
        "/api/v1/settings/import",
        json={"candidates": {"theme": None}, "selections": ["theme"]},
    )
    assert response.status_code == 200
    assert _stored_values(config_path)["theme"] == "matrix"


def test_an_oversized_offer_is_refused_before_validation(client):
    api, _ = client
    response = api.post(
        "/api/v1/settings/import",
        json={"candidates": {f"f{i}": 1 for i in range(200)}},
    )
    assert response.status_code == 400


# ---------------------------------------------------------------------
# The revision check, and the control that proves it is doing something.
# ---------------------------------------------------------------------


def test_a_stale_revision_refuses_and_says_what_is_current(client):
    api, config_path = client
    _seed(config_path, {"theme": "claude"}, revision=7)
    response = api.post(
        "/api/v1/settings/import",
        json={
            "candidates": {"theme": "matrix"},
            "selections": ["theme"],
            "expected_revision": 3,
        },
    )
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["status"] == settings_import.STALE_REVISION
    assert detail["revision"] == 7
    assert _stored_values(config_path)["theme"] == "claude"
    assert not settings_import.is_completed(json.loads(config_path.read_text()))


def test_without_the_check_the_same_import_would_have_landed(client):
    """The control. Without it the test above proves nothing about the check."""
    api, config_path = client
    _seed(config_path, {"theme": "claude"}, revision=7)
    response = api.post(
        "/api/v1/settings/import",
        json={
            "candidates": {"theme": "matrix"},
            "selections": ["theme"],
            "expected_revision": None,
        },
    )
    assert response.status_code == 200
    assert _stored_values(config_path)["theme"] == "matrix"


# ---------------------------------------------------------------------
# The state endpoint.
# ---------------------------------------------------------------------


def test_the_state_endpoint_publishes_the_allowlist_rather_than_the_client(client):
    api, _ = client
    state = api.get("/api/v1/settings/import/state").json()
    assert set(state["importable"]) == set(settings_import.importable_fields())
    assert state["refused"] == sorted(settings_import.REFUSED_FIELDS)
    assert "claude_tunnel_token" not in state["importable"]
    assert "theme_script_consent" not in state["importable"]


def test_a_fresh_install_reports_nothing_imported(client):
    api, _ = client
    state = api.get("/api/v1/settings/import/state").json()
    assert state["completed"] is False
    assert state["completed_at"] is None
    assert state["imported_fields"] == []


def test_an_unreadable_marker_re_offers_rather_than_refusing_forever(tmp_path):
    """Tolerant in the recoverable direction only."""
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({settings_import.IMPORT_MARKER_KEY: "not an object"})
    )
    store = SettingsImportStore(lambda: config_path)
    assert store.state()["completed"] is False


# ---------------------------------------------------------------------
# The two ends of the allowlist have to agree.
# ---------------------------------------------------------------------


def _collector_fields() -> list:
    """Ask the real client module what it can offer.

    Description: runs client/js/settings-import-collect.js under node
      rather than parsing it, because a regex over the source would agree
      with a table that no longer matches the readers beside it.
    Inputs: none.
    Output: list[str].
    Raises: pytest.skip - node is not installed, so nothing was measured.
    """
    import shutil
    import subprocess

    node = shutil.which("node")
    if not node:
        pytest.skip(
            "node is not installed, so the client collector's field set "
            "went unmeasured against the server's allowlist"
        )
    module = ROOT / "client" / "js" / "settings-import-collect.js"
    script = (
        "const m = require(%s);" % json.dumps(str(module))
        + "process.stdout.write(JSON.stringify(m.fields()));"
    )
    out = subprocess.run(
        [node, "-e", script], capture_output=True, text=True, timeout=30
    )
    if out.returncode != 0:
        pytest.fail(f"the client collector would not load under node: {out.stderr}")
    # The module logs its own load banner to stdout, like every other
    # client module, so take the LAST line rather than the whole stream.
    lines = [line for line in out.stdout.splitlines() if line.strip()]
    if not lines:
        pytest.fail("the client collector printed nothing")
    return json.loads(lines[-1])


def test_every_field_the_browser_can_offer_is_one_the_server_will_take():
    """A collector ahead of the server offers settings nothing can store.

    The failure is quiet: the field lands in the preview as refused, the
    user sees a row saying a setting they really have will not be
    carried, and nobody finds out until they read the list closely.
    """
    offered = set(_collector_fields())
    importable = settings_import.importable_fields()
    assert offered <= importable, (
        "the browser collector offers fields this server cannot import: "
        f"{sorted(offered - importable)}"
    )


def test_the_collector_does_not_offer_the_refused_field():
    assert settings_import.REFUSED_FIELDS.isdisjoint(set(_collector_fields()))


def test_a_collected_payload_previews_and_imports_end_to_end(client):
    """The real client field set, through the real endpoints, once."""
    api, config_path = client
    offered = _collector_fields()
    # One plausible value per offerable field, built from the server's own
    # validators rather than invented, so this test cannot drift into
    # asserting against values the block would refuse.
    sample = {
        "theme": "matrix",
        "audio_enabled": True,
        "audio_master_volume": 0.8,
        "launch_last_model": "anthropic/claude-3",
        "sidebar_density": "compact",
        "sidebar_arrangement": {
            "v": 1, "pinned": ["a"], "order": ["a"], "collapsed": ["pinned"]
        },
        "sidebar_pinned": True,
        "config_editor_pinned": False,
        "config_editor_collapsed": {"user:__root__": True},
        "launchpad_collapsed": {"recent-sessions": True},
    }
    candidates = {field: sample[field] for field in offered if field in sample}
    assert set(candidates) == set(offered), (
        "this test has no sample value for a field the collector can offer, "
        "so that field went unmeasured"
    )

    preview = api.post(
        "/api/v1/settings/import/preview",
        json={"candidates": candidates, "selections": []},
    ).json()
    promised = {
        row["field"]: row["candidate"] for row in preview["fields"] if row["writes"]
    }
    assert promised == candidates

    body = api.post(
        "/api/v1/settings/import",
        json={"candidates": candidates, "selections": []},
    ).json()
    assert body["changed"] == promised
    assert _stored_values(config_path) == candidates
