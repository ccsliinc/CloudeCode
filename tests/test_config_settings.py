"""feat/settings-screen — tests for GET/PATCH /api/v1/config/settings.

Covers:
- GET masks every notification secret as {"configured": bool}, never the
  raw value, and includes the resolved effective_claude_command preview.
- PATCH agents: partial update leaves unset fields untouched; a blank
  codex/hermes/openclaw command is rejected (no fallback for those,
  unlike claude_command which may be legitimately cleared to "").
- PATCH notifications: an omitted secret field is left unchanged in
  config.json; a provided one overwrites it; the response never echoes
  a raw secret back.
- Unknown top-level/nested keys are rejected outright (422) rather than
  silently merged.
- Atomic write: config.json.bak is created with the pre-write content,
  no stray .tmp file survives, and a crash-mid-write can't corrupt the
  file (verified via the same tmp+replace primitives the rest of
  src/config.py already uses).

Hermetic — no real config.json touched; every test gets its own
tmp_path config.json and points `settings.auth_config_file` at it.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_cs_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_cs_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.auth import require_auth
from src.api.auth_routes import router as auth_router
from src.config import settings


BASE_CONFIG = {
    "projects": [],
    "agents": {
        "claude_command": "",
        "codex_command": "codex",
        "hermes_command": "hermes",
        "openclaw_command": "openclaw tui",
    },
    "notifications": {
        "enabled": True,
        "ntfy_base_url": "https://ntfy.sh",
        "ntfy_topic": "topic-secret-abc",
        "slack_webhook_url": "https://hooks.slack.com/services/T/B/X",
        "pushover_token": "tok123",
        "pushover_user_key": "userkey456",
    },
}


def _write_config(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2))


@pytest.fixture()
def config_path(tmp_path, monkeypatch):
    """Point the singleton `settings` at a throwaway config.json and reset
    its load cache before/after so tests don't leak state into each other
    or into the developer's real config."""
    path = tmp_path / "config.json"
    _write_config(path, BASE_CONFIG)
    monkeypatch.setattr(settings, "auth_config_file", str(path))
    settings._auth_config_cache = None
    yield path
    settings._auth_config_cache = None


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(auth_router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: True
    return TestClient(app)


# --------------------------------------------------------------------------- #
# GET — masking + effective command preview
# --------------------------------------------------------------------------- #


def test_get_settings_masks_all_secrets(client, config_path):
    resp = client.get("/api/v1/config/settings")
    assert resp.status_code == 200, resp.text
    body = resp.text
    # None of the raw secret values may appear anywhere in the response body.
    for secret in ("topic-secret-abc", "T/B/X", "tok123", "userkey456"):
        assert secret not in body

    data = resp.json()
    notif = data["notifications"]
    assert notif["ntfy_topic"] == {"configured": True}
    assert notif["slack_webhook_url"] == {"configured": True}
    assert notif["pushover_token"] == {"configured": True}
    assert notif["pushover_user_key"] == {"configured": True}
    # Non-secret fields ARE returned in plain text.
    assert notif["ntfy_base_url"] == "https://ntfy.sh"
    assert notif["enabled"] is True
    assert notif["restart_required"] is True


def test_get_settings_effective_claude_command_reflects_fallback(client, config_path):
    """claude_command is empty in BASE_CONFIG -> fallback zsh/cld wrapper."""
    resp = client.get("/api/v1/config/settings")
    assert resp.status_code == 200
    effective = resp.json()["agents"]["effective_claude_command"]
    assert "cld" in effective
    assert effective.startswith("zsh -c")


def test_get_settings_server_section_is_read_only(client, config_path):
    resp = client.get("/api/v1/config/settings")
    assert resp.status_code == 200
    server = resp.json()["server"]
    assert server["editable"] is False
    assert "host" in server


# --------------------------------------------------------------------------- #
# PATCH agents
# --------------------------------------------------------------------------- #


def test_patch_agents_updates_only_given_field(client, config_path):
    resp = client.patch(
        "/api/v1/config/settings",
        json={"agents": {"claude_command": "claude --dangerously-skip-permissions"}},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["agents"]["claude_command"] == "claude --dangerously-skip-permissions"
    assert "cld" not in data["agents"]["effective_claude_command"]
    assert "claude --dangerously-skip-permissions" in data["agents"]["effective_claude_command"]
    # Untouched fields survive unchanged.
    assert data["agents"]["codex_command"] == "codex"

    on_disk = json.loads(config_path.read_text())
    assert on_disk["agents"]["codex_command"] == "codex"
    assert on_disk["agents"]["hermes_command"] == "hermes"


def test_patch_agents_rejects_blank_codex_command(client, config_path):
    resp = client.patch(
        "/api/v1/config/settings",
        json={"agents": {"codex_command": "   "}},
    )
    assert resp.status_code == 400
    # Config on disk must be untouched.
    on_disk = json.loads(config_path.read_text())
    assert on_disk["agents"]["codex_command"] == "codex"


def test_patch_agents_allows_blank_claude_command(client, config_path):
    """claude_command has a real fallback (cld/cldor) so clearing it to
    empty is a legitimate, common settings-screen action."""
    # Seed a non-empty value first so the clear is observable.
    cfg = json.loads(config_path.read_text())
    cfg["agents"]["claude_command"] = "claude --dangerously-skip-permissions"
    _write_config(config_path, cfg)
    settings._auth_config_cache = None

    resp = client.patch(
        "/api/v1/config/settings",
        json={"agents": {"claude_command": ""}},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["agents"]["claude_command"] == ""
    assert resp.json()["agents"]["effective_claude_command"].endswith("cld'")


# --------------------------------------------------------------------------- #
# PATCH notifications — leave-unchanged + never-echo-raw-secret
# --------------------------------------------------------------------------- #


def test_patch_notifications_omitted_secret_stays_unchanged(client, config_path):
    resp = client.patch(
        "/api/v1/config/settings",
        json={"notifications": {"ntfy_base_url": "https://ntfy.example.com"}},
    )
    assert resp.status_code == 200, resp.text

    on_disk = json.loads(config_path.read_text())
    assert on_disk["notifications"]["ntfy_base_url"] == "https://ntfy.example.com"
    # Secrets we never mentioned in the PATCH are byte-for-byte unchanged.
    assert on_disk["notifications"]["ntfy_topic"] == "topic-secret-abc"
    assert on_disk["notifications"]["slack_webhook_url"] == "https://hooks.slack.com/services/T/B/X"


def test_patch_notifications_provided_secret_overwrites_and_is_never_echoed(client, config_path):
    resp = client.patch(
        "/api/v1/config/settings",
        json={"notifications": {"pushover_token": "brand-new-token-xyz"}},
    )
    assert resp.status_code == 200, resp.text
    assert "brand-new-token-xyz" not in resp.text

    on_disk = json.loads(config_path.read_text())
    assert on_disk["notifications"]["pushover_token"] == "brand-new-token-xyz"
    # The OTHER pushover field (also secret, not sent) is untouched.
    assert on_disk["notifications"]["pushover_user_key"] == "userkey456"


# --------------------------------------------------------------------------- #
# Strict payload validation
# --------------------------------------------------------------------------- #


def test_patch_rejects_unknown_top_level_key(client, config_path):
    resp = client.patch(
        "/api/v1/config/settings",
        json={"host": "0.0.0.0"},
    )
    assert resp.status_code == 422
    on_disk = json.loads(config_path.read_text())
    assert on_disk == BASE_CONFIG


def test_patch_rejects_unknown_nested_key(client, config_path):
    resp = client.patch(
        "/api/v1/config/settings",
        json={"agents": {"claude_command": "ok", "sudo_command": "rm -rf /"}},
    )
    assert resp.status_code == 422
    on_disk = json.loads(config_path.read_text())
    assert on_disk["agents"]["claude_command"] == ""


def test_patch_empty_body_is_a_harmless_noop(client, config_path):
    resp = client.patch("/api/v1/config/settings", json={})
    assert resp.status_code == 200, resp.text
    on_disk = json.loads(config_path.read_text())
    assert on_disk == BASE_CONFIG


# --------------------------------------------------------------------------- #
# Atomic write + backup
# --------------------------------------------------------------------------- #


def test_patch_writes_backup_of_prior_content(client, config_path):
    before = config_path.read_text()
    resp = client.patch(
        "/api/v1/config/settings",
        json={"agents": {"claude_command": "custom-cmd"}},
    )
    assert resp.status_code == 200, resp.text

    backup_path = config_path.with_suffix(config_path.suffix + ".bak")
    assert backup_path.exists()
    assert backup_path.read_text() == before


def test_patch_leaves_no_stray_tmp_file(client, config_path):
    resp = client.patch(
        "/api/v1/config/settings",
        json={"agents": {"claude_command": "custom-cmd"}},
    )
    assert resp.status_code == 200, resp.text
    tmp_path = config_path.with_suffix(config_path.suffix + ".tmp")
    assert not tmp_path.exists()


def test_patch_result_is_valid_json_at_every_step(client, config_path):
    """Belt-and-suspenders: after a successful PATCH, config.json parses
    cleanly (the atomic tmp+replace never left a torn write)."""
    resp = client.patch(
        "/api/v1/config/settings",
        json={"notifications": {"enabled": False}},
    )
    assert resp.status_code == 200, resp.text
    json.loads(config_path.read_text())  # raises if corrupted


# --------------------------------------------------------------------------- #
# The atomic write, tested by its MECHANISM rather than by its outcome         #
# --------------------------------------------------------------------------- #
#
# A mutation that replaced tmp-plus-fsync-plus-os.replace with a plain
# in-place ``open(path, "w")`` came back GREEN across every test above,
# and the reason is that both paths produce IDENTICAL final bytes. Only a
# failure PART WAY THROUGH tells them apart, and that is precisely the
# case the atomic write exists for: a half-written config.json costs the
# user their whole setup.
#
# So the property is staged rather than waited for. ``json.dump`` is made
# to raise after it has already emitted some output; with a temp file the
# destination is untouched, and with an in-place write the destination is
# left truncated.


def test_a_write_that_fails_part_way_leaves_config_json_intact(
    config_path, monkeypatch
):
    """THE ATOMIC WRITE, stated as the harm it prevents.

    Description: this is the test the plan names for slice S5. Without
      it, replacing the temp-file-plus-rename with a direct write passes
      every other assertion in this file, because the two differ only
      when the write does not finish.
    Inputs: config_path (Path) - the fixture's config.json;
      monkeypatch - used to make serialisation fail mid-stream.
    Output: None.
    """
    import json as _json

    from src.config import config_file

    before = config_path.read_text()

    def _dump_then_die(obj, fp, **kwargs):
        """Emit a plausible prefix, then fail the way a full disk would."""
        fp.write('{"agents": {"claude_comm')
        raise OSError("no space left on device")

    monkeypatch.setattr(config_file.json, "dump", _dump_then_die)

    with pytest.raises(OSError):
        config_file.write_config_atomic(
            config_path,
            {"agents": {"claude_command": "new"}},
            previous=before,
            event="test_backup_failed",
        )

    assert config_path.read_text() == before, (
        "a write that failed part way through changed config.json; the "
        "destination must only ever be replaced by a completed rename"
    )
    # And it is still parseable, which is the form the user meets it in.
    assert _json.loads(config_path.read_text())


def test_the_destination_is_reached_by_a_rename_and_not_by_a_write(
    config_path, monkeypatch
):
    """The mechanism itself, so the property cannot be satisfied by luck.

    Description: the test above proves the OUTCOME. This proves HOW: the
      destination path is never opened for writing, only renamed onto.
      An implementation that wrote in place and happened to survive would
      pass the first test on a machine where nothing failed, and fails
      here by construction.
    """
    from src.config import config_file

    real_open = open
    opened_for_write = []

    def _tracking_open(file, mode="r", *args, **kwargs):
        if "w" in mode or "a" in mode or "+" in mode:
            opened_for_write.append(str(file))
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(config_file, "open", _tracking_open, raising=False)

    config_file.write_config_atomic(
        config_path,
        {"agents": {"claude_command": "renamed-in"}},
        previous=config_path.read_text(),
        event="test_backup_failed",
    )

    assert str(config_path) not in opened_for_write, (
        "config.json itself was opened for writing; the destination must "
        f"only be reached by os.replace. Opened: {opened_for_write}"
    )
    assert any(p.endswith(".tmp") for p in opened_for_write), (
        "nothing was written through a temp file at all"
    )


# --------------------------------------------------------------------------- #
# The cache, and the merge guard                                              #
# --------------------------------------------------------------------------- #
#
# Two more mutations came back GREEN against everything above, and both
# for the same reason: the fixture empties ``_auth_config_cache`` before
# every test, so no test in this file has ever exercised a WARM cache -
# which is the only state a running server is ever in after its first
# read.


def test_a_save_is_visible_through_an_already_warm_cache(client, config_path):
    """A writer must invalidate the parse taken before the write.

    Description: the read below WARMS the cache, which is what a running
      server's is after the first request. Without the invalidation the
      PATCH writes to disk correctly and then reports the PRE-write value
      straight back, so the settings screen repaints with the change
      apparently undone.
    """
    from src.config import settings as live_settings

    # Warm it, the way any earlier request would have.
    assert live_settings.load_auth_config().agents.claude_command != "warm-cache-cmd"
    assert live_settings._auth_config_cache is not None

    resp = client.patch(
        "/api/v1/config/settings",
        json={"agents": {"claude_command": "warm-cache-cmd"}},
    )
    assert resp.status_code == 200, resp.text

    assert resp.json()["agents"]["claude_command"] == "warm-cache-cmd", (
        "the response carried the pre-write value; the cached config was "
        "not invalidated by the write"
    )
    assert (
        live_settings.load_auth_config().agents.claude_command == "warm-cache-cmd"
    )


def test_a_merge_that_would_not_validate_never_reaches_disk(config_path):
    """DEFENCE IN DEPTH, and it is defending something reachable.

    Description: the route does field-level checks first, so this state
      is reached only from a config.json a human edited into a shape a
      valid partial update cannot fix. Without the re-validation the bad
      merge is written, and the NEXT load quietly falls back to that
      block's defaults - which is the user's whole notifications setup
      disappearing with no error anywhere.
    """
    from src.config import config_writes

    before = config_path.read_text()

    with pytest.raises(ValueError):
        config_writes.update_settings_config(
            config_path,
            notifications_update={"enabled": "not-a-boolean-at-all"},
        )

    assert config_path.read_text() == before, (
        "a merged block that pydantic refuses was written to disk"
    )
