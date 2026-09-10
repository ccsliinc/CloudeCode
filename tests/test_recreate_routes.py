"""The recreate endpoints, and the row re-key they rest on.

TWO CLAIMS ARE BEING TESTED, and they fail in different places.

Over HTTP: that the socket measurement REACHES the decision. Presence is
measured once per request and every gate downstream reads it, so a
version that gathered it and then forgot to pass it would answer 200 with
a perfectly worded plan for a session that is still running. Presence is
therefore injected here rather than measured, so each of the three
outcomes can be driven; ``tests/test_session_recreate.py`` is where the
measurement itself is pinned.

Against a real database: that the row SURVIVES. The whole point of a
recreate over a hand-built session is that ``sessions.id`` holds still
while the instance triple moves, so the project binding, the title and
the conversation link ride along. That is ``rebind_instance``, and it is
exercised here against a migrated schema with a project actually bound to
the row - because "it kept its project" is the claim a user would notice
being wrong, and no amount of reading the UPDATE proves it.
"""

from __future__ import annotations

import os
import tempfile

import pytest

# The same four the imported-restart route test sets, for the same
# reason: src/config.py builds a Settings at import time and these are
# its required fields. setdefault, so a real environment wins.
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_rc_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_rc_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

pytest.importorskip("fastapi")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from src.api.auth import require_auth  # noqa: E402
from src.api import recreate_routes  # noqa: E402
from src.core.db import connect, db_path_for  # noqa: E402
from src.core.db_migration import ensure_db_migrated  # noqa: E402
from src.core.session_recreate_presence import (  # noqa: E402
    TMUX_GONE,
    TMUX_PRESENT,
    TMUX_UNKNOWN,
    TmuxPresence,
)

NAME = "cloude_recreate_demo"
ROW_UUID = "row-uuid-recreate"
CONV_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


@pytest.fixture()
def app_env(tmp_path, monkeypatch):
    """A TestClient over the recreate routes and a real migrated datastore."""
    from src.config import settings

    state_dir = tmp_path / "state"
    state_dir.mkdir()
    monkeypatch.setattr(
        type(settings), "get_state_dir", lambda self: state_dir, raising=True
    )
    monkeypatch.setattr(
        recreate_routes, "_socket_name", lambda: "cloude", raising=True
    )
    assert ensure_db_migrated(state_dir).status == "ok"

    app = FastAPI()
    app.include_router(recreate_routes.router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: {"sub": "test"}
    with TestClient(app) as client:
        yield client, state_dir, monkeypatch


def _presence(monkeypatch, outcome, detail="measured in the test"):
    """Drive the socket measurement without a tmux server.

    Inputs: monkeypatch, outcome (str), detail (str). Output: None.
    """
    monkeypatch.setattr(
        recreate_routes,
        "_measure_presence",
        lambda name, socket_name: TmuxPresence(outcome=outcome, detail=detail),
        raising=True,
    )


def _insert(state_dir, **overrides):
    """Write one sessions row that HAS a tmux identity.

    Inputs: state_dir (Path), **overrides. Output: str - session_uuid.
    """
    row = {
        "session_uuid": ROW_UUID,
        "tmux_name": NAME,
        "tmux_created_epoch": 1788821572,
        "working_dir": "/Users/x/proj",
        "claude_session_uuid": CONV_UUID,
        "title": "fix the deploy script",
    }
    row.update(overrides)
    # ux_sessions_claude_uuid is a UNIQUE partial index, so a second row in
    # the same test needs its own conversation. Derived from the row's own
    # uuid rather than passed, so no caller has to remember.
    if row["session_uuid"] != ROW_UUID and "claude_session_uuid" not in overrides:
        row["claude_session_uuid"] = f"{row['session_uuid']}-conv"
    with connect(db_path_for(state_dir), create=False) as conn:
        conn.execute(
            "INSERT INTO sessions (session_uuid, tmux_socket, tmux_name, "
            "tmux_created_epoch, working_dir, claude_session_uuid, title, "
            "origin, lifecycle, created_at, updated_at) "
            "VALUES (?, 'cloude', ?, ?, ?, ?, ?, 'created', 'stopped', "
            "'2026-03-01T00:00:00Z', '2026-09-08T00:00:00Z')",
            (
                row["session_uuid"],
                row["tmux_name"],
                row["tmux_created_epoch"],
                row["working_dir"],
                row["claude_session_uuid"],
                row["title"],
            ),
        )
    return row["session_uuid"]


def test_a_gone_session_previews_a_recreate(app_env):
    """The pane state reads dead, and the sentence says what happens."""
    client, state_dir, mp = app_env
    _insert(state_dir)
    _presence(mp, TMUX_GONE, "not on the socket")

    r = client.get(
        "/api/v1/sessions/recreate/preview", params={"session_uuid": ROW_UUID}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pane_state"] == "dead"
    assert body["unchanged"]["actionable"] is False, (
        "an unpicked recreate is never offered - there is no recorded "
        "start command left to fall back on"
    )
    assert body["name"] == "fix the deploy script"


def test_a_live_session_previews_alive_and_offers_nothing(app_env):
    """NEGATIVE CONTROL, and the one that protects a running agent.

    Presence is the gate, so a measured-present session must arrive with
    every option unactionable no matter how good its wrapper list is.
    """
    client, state_dir, mp = app_env
    _insert(state_dir)
    _presence(mp, TMUX_PRESENT, "still on the socket")

    r = client.get(
        "/api/v1/sessions/recreate/preview", params={"session_uuid": ROW_UUID}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pane_state"] == "alive"
    assert body["unchanged"]["kind"] == "not_dead"
    assert all(o["actionable_now"] is False for o in body["options"])


def test_an_unmeasured_socket_previews_unknown_and_offers_nothing(app_env):
    """Not having looked is not evidence of absence."""
    client, state_dir, mp = app_env
    _insert(state_dir)
    _presence(mp, TMUX_UNKNOWN, "could not list the socket")

    r = client.get(
        "/api/v1/sessions/recreate/preview", params={"session_uuid": ROW_UUID}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pane_state"] == "unknown"
    assert body["unchanged"]["kind"] == "cannot_determine"
    assert all(o["actionable_now"] is False for o in body["options"])


def test_a_uuid_no_record_carries_is_a_404(app_env):
    client, _, mp = app_env
    _presence(mp, TMUX_GONE)
    r = client.get(
        "/api/v1/sessions/recreate/preview", params={"session_uuid": "no-such-row"}
    )
    assert r.status_code == 404


def test_a_row_that_never_had_a_tmux_session_is_a_409(app_env):
    """NEGATIVE CONTROL: the two create-a-session paths cannot silently
    swap. An imported row belongs to the imported endpoints, and a 409
    rather than a 404 because the row EXISTS - the caller used the wrong
    endpoint for it.
    """
    client, state_dir, mp = app_env
    _insert(state_dir, tmux_name=None, tmux_created_epoch=None)
    _presence(mp, TMUX_GONE)

    r = client.get(
        "/api/v1/sessions/recreate/preview", params={"session_uuid": ROW_UUID}
    )
    assert r.status_code == 409
    assert "imported" in r.json()["detail"]


def test_the_route_is_addressed_by_the_durable_key_not_by_the_tmux_name():
    """A NAME IS NOT AN IDENTITY, and this route must never take one.

    A tmux name is reusable and this app re-mints them, so
    "the newest row with this name" is a recency guess. A wrong answer
    here rebinds a DIFFERENT session's row onto a tmux session it has
    nothing to do with. ``tests/test_no_name_keyed_session_identity.py``
    caught the first draft of this module doing exactly that; this
    asserts the request shape that made it impossible, so a future edit
    cannot quietly add the name back as an alternative key.
    """
    from src.api.recreate_routes import RecreateRequest

    fields = set(RecreateRequest.model_fields)
    assert "session_uuid" in fields
    assert "session_name" not in fields, (
        "the caller supplies the durable key; the tmux name is read off "
        "the row it resolves"
    )


def test_the_action_refuses_a_live_session_and_spawns_nothing(app_env):
    """THE LOAD-BEARING REFUSAL. A 200 with status='refused', and no
    session manager is ever reached - which is also why this test needs
    none on app.state.
    """
    client, state_dir, mp = app_env
    _insert(state_dir)
    _presence(mp, TMUX_PRESENT, "still on the socket")

    r = client.post(
        "/api/v1/sessions/recreate",
        json={"session_uuid": ROW_UUID, "agent_type": "claude"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "refused"
    assert body["presence"] == "present"
    assert body["session_uuid"] == ROW_UUID
    assert body["detail"]


def test_the_action_refuses_an_unconfigured_wrapper(app_env):
    """``agent_type`` is an ID validated against the configured wrappers,
    never a command, and an unknown one must not fall back to the default."""
    client, state_dir, mp = app_env
    _insert(state_dir)
    _presence(mp, TMUX_GONE)

    r = client.post(
        "/api/v1/sessions/recreate",
        json={"session_uuid": ROW_UUID, "agent_type": "not-a-configured-wrapper"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "refused"


# --- the re-key the whole feature rests on ---------------------------------


def test_the_row_keeps_its_id_project_and_title_across_the_rekey(tmp_path):
    """A recreate moves the INSTANCE, not the session.

    ``sessions.id`` and ``session_uuid`` hold still while the triple
    moves, which is what carries the project binding, the title and the
    conversation link onto the new tmux session. Asserted against a real
    migrated schema rather than read off the UPDATE, because a column
    left out of that statement reads perfectly and loses the user's
    project.
    """
    from src.core.session_restart import rebind_instance

    state_dir = tmp_path / "state"
    state_dir.mkdir()
    assert ensure_db_migrated(state_dir).status == "ok"
    uuid = _insert(state_dir)

    db = db_path_for(state_dir)
    with connect(db, create=False) as conn:
        conn.execute(
            "INSERT INTO projects (root, raw_path, display_name, source, "
            "created_at, updated_at) VALUES ('/Users/x/proj', '/Users/x/proj', "
            "'proj', 'declared', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
        )
        project_id = conn.execute(
            "SELECT id FROM projects WHERE display_name = 'proj'"
        ).fetchone()[0]
        conn.execute(
            "UPDATE sessions SET project_id = ?, project_attribution = "
            "'declared' WHERE session_uuid = ?",
            (project_id, uuid),
        )
        before = dict(
            conn.execute(
                "SELECT * FROM sessions WHERE session_uuid = ?", (uuid,)
            ).fetchone()
        )

        result = rebind_instance(
            conn,
            row_id=int(before["id"]),
            socket="cloude",
            name=NAME,
            epoch=1788999999,
            tmux_session_id="$9",
            working_dir=before["working_dir"],
        )
        conn.commit()
        after = dict(
            conn.execute(
                "SELECT * FROM sessions WHERE id = ?", (before["id"],)
            ).fetchone()
        )

    assert result.rebound is True, result.detail
    # The instance moved.
    assert before["tmux_created_epoch"] != after["tmux_created_epoch"]
    assert after["tmux_created_epoch"] == 1788999999
    # The session did not.
    assert after["id"] == before["id"]
    assert after["session_uuid"] == uuid
    assert after["title"] == before["title"]
    assert after["project_id"] == project_id
    assert after["project_attribution"] == "declared"
    assert after["claude_session_uuid"] == CONV_UUID
    # And exactly one row still carries this session.
    with connect(db, create=False) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE session_uuid = ?", (uuid,)
        ).fetchone()[0] == 1


def test_group_membership_is_keyed_on_the_session_and_survives_the_rekey(
    tmp_path,
):
    """v24 keys ``session_group_membership`` on ``session_uuid``, not on
    the tmux name, so nothing about a recreate can orphan a filed session.

    Written as an assertion rather than a comment because the v8 table it
    replaced WAS keyed on the name, and that defect is exactly what an
    earlier design of this feature would have walked into.
    """
    from src.core.session_restart import rebind_instance

    state_dir = tmp_path / "state"
    state_dir.mkdir()
    assert ensure_db_migrated(state_dir).status == "ok"
    uuid = _insert(state_dir)

    with connect(db_path_for(state_dir), create=False) as conn:
        cols = {
            r["name"]
            for r in conn.execute(
                "PRAGMA table_info(session_group_membership)"
            ).fetchall()
        }
        assert "session_uuid" in cols and "tmux_name" not in cols

        conn.execute(
            "INSERT INTO session_groups (group_uuid, name, position, "
            "created_at, updated_at) VALUES ('grp-uuid-1', 'work', 0, "
            "'2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
        )
        group_id = conn.execute(
            "SELECT id FROM session_groups WHERE name = 'work'"
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO session_group_membership (session_uuid, group_id, "
            "position, added_at) VALUES (?, ?, 3, '2026-01-01T00:00:00Z')",
            (uuid, group_id),
        )
        row_id = conn.execute(
            "SELECT id FROM sessions WHERE session_uuid = ?", (uuid,)
        ).fetchone()[0]

        assert rebind_instance(
            conn,
            row_id=int(row_id),
            socket="cloude",
            name=NAME,
            epoch=1788999999,
        ).rebound is True
        conn.commit()

        kept = conn.execute(
            "SELECT group_id, position FROM session_group_membership "
            "WHERE session_uuid = ?",
            (uuid,),
        ).fetchone()

    assert kept is not None, "the recreate orphaned the session's group filing"
    assert kept["group_id"] == group_id
    assert kept["position"] == 3
