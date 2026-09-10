"""``GET`` and ``PATCH /api/v1/preferences``, and the change event.

THE TWO TESTS THAT MATTER MOST ARE THE REFUSALS, and issue #44 says so
outright: the stale-revision 409 and "a failed read never writes a
default" are the two shapes that silently corrupt a user's settings. A
suite that only proved a fresh write returns 200 would pass against an
endpoint with no check in it at all, which is why
``test_without_the_check_the_same_write_would_have_landed`` performs the
identical request with the check declined and asserts it overwrites.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_prefs_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_prefs_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.auth import require_auth
from src.api.preferences_routes import PREFERENCES_CHANGED_EVENT
from src.api.preferences_routes import router as preferences_router
from src.core.ui_preferences_store import UiPreferencesStore


class RecordingManager:
    """A stand-in for the WebSocket manager that keeps what it was sent.

    Not a mock of the transport: it records the exact JSON string the
    route hands to ``broadcast``, so the assertions are about the frame
    the browser would actually receive rather than about call arguments.
    """

    def __init__(self) -> None:
        self.frames: list = []

    async def broadcast(self, message: str) -> None:
        self.frames.append(json.loads(message))


@pytest.fixture
def client(tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"agents": {"a": 1}}, indent=2))

    app = FastAPI()
    app.include_router(preferences_router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: {"sub": "test"}
    app.state.ui_preferences_store = UiPreferencesStore(lambda: config_path)
    app.state.connection_manager = RecordingManager()

    with TestClient(app) as test_client:
        yield test_client, config_path, app.state.connection_manager


def _get(client) -> dict:
    response = client.get("/api/v1/preferences")
    assert response.status_code == 200
    return response.json()


def _patch(client, changes, expected_revision=None, client_id=None):
    body = {"changes": changes}
    if expected_revision is not None:
        body["expected_revision"] = expected_revision
    if client_id is not None:
        body["client_id"] = client_id
    return client.patch("/api/v1/preferences", json=body)


# --------------------------------------------------------------------------
# The read.
# --------------------------------------------------------------------------


def test_a_fresh_install_reads_an_empty_block_at_revision_zero(client):
    test_client, _path, _manager = client
    body = _get(test_client)
    assert body["revision"] == 0
    assert body["values"] == {}
    assert body["schema_version"] == 1


def test_the_read_and_the_write_share_one_body_shape(client):
    test_client, _path, _manager = client
    read = _get(test_client)
    written = _patch(test_client, {"theme": "matrix"}).json()
    for field in ("status", "schema_version", "revision", "values"):
        assert field in read
        assert field in written


# --------------------------------------------------------------------------
# The write, and what it returns.
# --------------------------------------------------------------------------


def test_a_partial_update_returns_the_committed_values_and_the_revision(client):
    test_client, _path, _manager = client
    body = _patch(test_client, {"theme": "matrix"}).json()

    assert body["status"] == "committed"
    assert body["revision"] == 1
    assert body["values"]["theme"] == "matrix"
    assert body["changed"] == {"theme": "matrix"}


def test_a_partial_update_leaves_fields_it_did_not_mention_alone(client):
    test_client, _path, _manager = client
    _patch(test_client, {"theme": "matrix"})
    _patch(test_client, {"sidebar_density": "compact"})

    values = _get(test_client)["values"]
    assert values["theme"] == "matrix"
    assert values["sidebar_density"] == "compact"


def test_a_bad_value_is_a_400_and_writes_nothing(client):
    test_client, config_path, _manager = client
    before = config_path.read_text()

    response = _patch(test_client, {"sidebar_density": "enormous"})
    assert response.status_code == 400
    assert config_path.read_text() == before


def test_a_secret_name_is_a_400(client):
    test_client, _path, _manager = client
    assert _patch(test_client, {"claude_refresh_token": "x"}).status_code == 400


def test_an_unknown_top_level_body_field_is_rejected_before_the_handler(client):
    test_client, _path, _manager = client
    response = test_client.patch(
        "/api/v1/preferences", json={"changes": {"theme": "matrix"}, "sneaky": 1}
    )
    assert response.status_code == 422


# --------------------------------------------------------------------------
# THE REVISION CHECK. These two go together; neither means anything alone.
# --------------------------------------------------------------------------


def test_a_stale_revision_is_refused_with_409_and_the_current_state(client):
    test_client, _path, _manager = client
    _patch(test_client, {"theme": "matrix"})  # revision 1
    _patch(test_client, {"sidebar_density": "compact"})  # revision 2

    response = _patch(test_client, {"theme": "claude"}, expected_revision=1)

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["status"] == "stale_revision"
    assert detail["revision"] == 2
    # The client is told what is CURRENT, so it can reconcile rather than
    # retry blindly into the same conflict.
    assert detail["values"]["theme"] == "matrix"
    assert _get(test_client)["values"]["theme"] == "matrix"


def test_without_the_check_the_same_write_would_have_landed(client):
    """THE NEGATIVE CONTROL for the 409 above.

    Identical request, check declined. It must overwrite. If this ever
    stops overwriting, the test above has stopped proving that the CHECK
    is what refused, and this file fails rather than going quiet.
    """
    test_client, _path, _manager = client
    _patch(test_client, {"theme": "matrix"})
    _patch(test_client, {"sidebar_density": "compact"})

    response = _patch(test_client, {"theme": "claude"})

    assert response.status_code == 200
    assert _get(test_client)["values"]["theme"] == "claude"


def test_a_stale_write_raises_no_change_event(client):
    test_client, _path, manager = client
    _patch(test_client, {"theme": "matrix"})
    _patch(test_client, {"sidebar_density": "compact"})
    manager.frames.clear()

    _patch(test_client, {"theme": "claude"}, expected_revision=1)

    assert manager.frames == [], (
        "a refused write told other clients something changed; they would "
        "each refresh for a commit that never happened"
    )


def test_the_current_revision_is_accepted(client):
    test_client, _path, _manager = client
    _patch(test_client, {"theme": "matrix"})
    response = _patch(test_client, {"sidebar_density": "compact"}, expected_revision=1)
    assert response.status_code == 200
    assert response.json()["revision"] == 2


# --------------------------------------------------------------------------
# preferences.changed
# --------------------------------------------------------------------------


def test_a_commit_broadcasts_the_revision_and_only_the_fields_that_moved(client):
    test_client, _path, manager = client
    _patch(test_client, {"theme": "matrix", "sidebar_density": "compact"})
    manager.frames.clear()

    _patch(test_client, {"theme": "matrix", "sidebar_density": "cozy"})

    assert len(manager.frames) == 1
    frame = manager.frames[0]
    assert frame["type"] == PREFERENCES_CHANGED_EVENT
    assert frame["revision"] == 2
    assert frame["changed"] == {"sidebar_density": "cozy"}
    assert "theme" not in frame["changed"]


def test_a_no_op_write_raises_no_event_and_does_not_move_the_revision(client):
    test_client, _path, manager = client
    _patch(test_client, {"theme": "matrix"})
    manager.frames.clear()

    body = _patch(test_client, {"theme": "matrix"}).json()

    assert body["status"] == "unchanged"
    assert body["revision"] == 1
    assert manager.frames == []


def test_the_event_echoes_the_client_id_so_the_originator_can_skip_it(client):
    test_client, _path, manager = client
    _patch(test_client, {"theme": "matrix"}, client_id="browser-a")
    assert manager.frames[0]["origin_client_id"] == "browser-a"


def test_no_event_ever_carries_a_secret(client):
    test_client, _path, manager = client
    _patch(test_client, {"claude_tunnel_token": "x"})
    _patch(test_client, {"theme": "matrix"})

    encoded = json.dumps(manager.frames)
    assert "claude_tunnel_token" not in encoded
    assert "claude_refresh_token" not in encoded


def test_a_missing_websocket_manager_does_not_fail_the_save(client, tmp_path):
    test_client, config_path, _manager = client
    test_client.app.state.connection_manager = None

    response = _patch(test_client, {"theme": "matrix"})

    assert response.status_code == 200
    assert json.loads(config_path.read_text())["ui_preferences"]["revision"] == 1


# --------------------------------------------------------------------------
# A FAILED READ NEVER WRITES A DEFAULT. Issue #44 names this as one of
# the two failures that silently corrupt settings.
# --------------------------------------------------------------------------


def test_an_unreadable_config_reads_as_empty_and_stores_no_default(tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text("{not json")

    app = FastAPI()
    app.include_router(preferences_router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: {"sub": "test"}
    app.state.ui_preferences_store = UiPreferencesStore(lambda: config_path)
    app.state.connection_manager = RecordingManager()

    with TestClient(app) as test_client:
        body = _get(test_client)
        assert body["values"] == {}
        assert body["revision"] == 0

    # The read failing wrote nothing at all. A default persisted here
    # would be indistinguishable from a real setting the next time
    # anything read it.
    assert config_path.read_text() == "{not json"


def test_the_store_being_unmounted_is_a_503_rather_than_an_empty_block(tmp_path):
    app = FastAPI()
    app.include_router(preferences_router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: {"sub": "test"}

    with TestClient(app) as test_client:
        response = test_client.get("/api/v1/preferences")

    assert response.status_code == 503, (
        "answering an unmounted store with an empty block would invite a "
        "client to save its defaults over the user's real settings"
    )
