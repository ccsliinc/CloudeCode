"""One live session's folder to one archived project, and the refusals.

WHAT THIS IS DEFENDING. The terminal search panel's "Deep dive" widens a
search from the session in front of you to every past conversation in the
same project folder, and it does that by turning a live session's
``working_dir`` into an archive ``project_id``. A string equality test
would answer "no archived conversations for this folder" about a folder
holding hundreds of them, because ``~/Development`` on the owner's box is
a symlink into iCloud and a transcript records whichever spelling was in
force when it was written. That is gotcha 6, and it has already split
projects, sessions and transcripts in this codebase.

THE NEGATIVE CONTROLS ARE THE POINT. A matcher that always finds
something is worse than useless here: the cost of a wrong node is a Deep
dive that searches a stranger's conversations. So this file spends as
much of itself on what must NOT match - a sibling directory, a node with
no recorded cwd, a prefix of the right path - as on what must.

THE ROUTE HALF asserts the distinction the whole archive API is built
on: "no project holds this folder" is an ``ok`` with a null result, and
"the datastore would not open" is a ``cannot_determine``. Collapsing them
would report a database fault every time the user opened a terminal in a
brand new folder.
"""

from __future__ import annotations

import ast
import os
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_cwdl_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_cwdl_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.archive_project_lookup_routes import router as lookup_router
from src.api.auth import require_auth
from src.core.archive_cwd_lookup import (
    MATCH_ALIAS,
    MATCH_EXACT,
    MATCH_REALPATH,
    match_project_for_cwd,
    project_for_cwd_result,
)
from src.core.db import connect, db_path_for
from src.core.db_migration import ensure_db_migrated

LOOKUP_PATH = "/api/v1/archive/projects/for-cwd"


def _node(project_id: int, cwd: str | None, name: str = "P") -> dict:
    """One merged project node, trimmed to the fields the matcher reads.

    Args:
        project_id: The addressable id, the merge's FIRST member's.
        cwd: ``observed_cwd``; None models a node the merge could not
            prove belongs to any folder.
        name: ``display_name``.

    Returns:
        A dict shaped like one entry of ``GET /archive/projects``.

    Example:
        _node(1, "/tmp/a")["observed_cwd"]  # '/tmp/a'
    """
    return {
        "project_id": project_id,
        "display_name": name,
        "full_path": "-slug-" + str(project_id),
        "observed_cwd": cwd,
        "members": [{"project_id": project_id}],
    }


@pytest.fixture()
def symlinked_home(tmp_path):
    """A HOME whose ``Development`` is a symlink, as the owner's box is.

    The same fixture shape ``tests/test_claude_project_dirs.py`` uses,
    because this matcher is built on that module and a different fixture
    would be testing a different filesystem.

    Returns:
        ``(home, link_spelling, real_spelling)`` - two literal paths that
        denote ONE directory.
    """
    home = tmp_path / "home"
    real = home / "Library" / "Sync" / "Development" / "Proj"
    real.mkdir(parents=True)
    link = home / "Development"
    link.symlink_to(home / "Library" / "Sync" / "Development")
    return home, str(link / "Proj"), str(real)


# --------------------------------------------------------------------------- #
# 1. The three rungs, each reported by name.
# --------------------------------------------------------------------------- #


def test_the_spelling_the_session_carries_matches_verbatim(tmp_path):
    """The ordinary case: the node recorded the same string."""
    here = str(tmp_path)
    node, matched_by = match_project_for_cwd([_node(7, here)], here)
    assert node is not None and node["project_id"] == 7
    assert matched_by == MATCH_EXACT


def test_a_node_recorded_under_the_resolved_spelling_still_matches(
    symlinked_home,
):
    """The session says ``~/Development/Proj``, the node says iCloud.

    FAILS WITHOUT THE LADDER, and fails silently: the folder reads as
    having no archived conversations while its whole history sits in the
    archive under the other spelling.
    """
    home, link_spelling, real_spelling = symlinked_home
    node, matched_by = match_project_for_cwd(
        [_node(3, real_spelling)], link_spelling, home=home
    )
    assert node is not None and node["project_id"] == 3
    assert matched_by == MATCH_REALPATH


def test_a_node_recorded_under_the_symlinked_spelling_still_matches(
    symlinked_home,
):
    """And the same in reverse, which needs the ``$HOME`` alias scan.

    Resolving the session's path alone cannot produce ``~/Development``;
    only reading the home directory's symlink table can.
    """
    home, link_spelling, real_spelling = symlinked_home
    node, matched_by = match_project_for_cwd(
        [_node(4, link_spelling)], real_spelling, home=home
    )
    assert node is not None and node["project_id"] == 4
    assert matched_by == MATCH_ALIAS


def test_the_strongest_rung_wins_when_two_nodes_could_answer(
    symlinked_home,
):
    """A verbatim hit outranks a resolved one, and says so.

    Order matters because the label is reported: a plain match reported
    as an alias would send someone reading a log after a symlink problem
    that is not there.
    """
    home, link_spelling, real_spelling = symlinked_home
    nodes = [_node(9, real_spelling), _node(2, link_spelling)]
    node, matched_by = match_project_for_cwd(nodes, link_spelling, home=home)
    assert node["project_id"] == 2
    assert matched_by == MATCH_EXACT


def test_a_node_whose_cwd_only_resolves_equal_is_the_last_rung(tmp_path):
    """``same_directory`` catches a spelling the alias table cannot make.

    The node's OWN path is the symlink here, and it is not under ``$HOME``
    at all, so no forward spelling of the session's directory produces
    it. Resolving both sides does.
    """
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    node, matched_by = match_project_for_cwd(
        [_node(5, str(link))], str(real), home=tmp_path / "nohome"
    )
    assert node is not None and node["project_id"] == 5
    assert matched_by == MATCH_REALPATH


# --------------------------------------------------------------------------- #
# 2. The refusals. A matcher that always finds something is worse than none.
# --------------------------------------------------------------------------- #


def test_a_different_folder_never_matches(tmp_path):
    """THE NEGATIVE CONTROL every rung above is measured against."""
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    assert match_project_for_cwd([_node(1, str(a))], str(b)) == (None, None)


def test_a_prefix_of_the_path_is_not_a_match(tmp_path):
    """No prefix rule, deliberately.

    ``/Users/jsugamelevil`` is not inside ``/Users/jsugamele``, and a
    parent folder's archive is not this folder's archive.
    """
    parent = tmp_path / "proj"
    child = parent / "sub"
    child.mkdir(parents=True)
    assert match_project_for_cwd([_node(1, str(parent))], str(child)) == (
        None, None,
    )
    assert match_project_for_cwd([_node(1, str(child))], str(parent)) == (
        None, None,
    )


def test_a_node_with_no_recorded_cwd_is_skipped(tmp_path):
    """The merge keys those on their own id BECAUSE they cannot be placed.

    Matching one here would invent exactly the evidence the merge
    refused to invent.
    """
    assert match_project_for_cwd([_node(1, None)], str(tmp_path)) == (None, None)


def test_no_cwd_at_all_refuses_rather_than_matching_the_first_node(tmp_path):
    """An imported session carries no working directory."""
    assert match_project_for_cwd([_node(1, str(tmp_path))], None) == (None, None)
    assert match_project_for_cwd([_node(1, str(tmp_path))], "") == (None, None)


def test_an_empty_archive_refuses(tmp_path):
    """Nothing to match against is a miss, not a fault."""
    assert match_project_for_cwd([], str(tmp_path)) == (None, None)


# --------------------------------------------------------------------------- #
# 3. The envelope: a miss is an answer, and it carries the rung.
# --------------------------------------------------------------------------- #


def test_a_hit_carries_the_addressable_id_and_the_rung(tmp_path):
    """The client needs an id to build the deep link, and nothing else."""
    here = str(tmp_path)
    env = project_for_cwd_result([_node(11, here, name="Sync")], here)

    assert env["result_status"] == "ok"
    assert env["result"]["project_id"] == 11
    assert env["result"]["display_name"] == "Sync"
    assert env["result"]["observed_cwd"] == here
    assert env["result"]["matched_by"] == MATCH_EXACT
    assert env["meta"]["matched_by"] == MATCH_EXACT
    # NOT a second serialization of the merged node.
    assert "members" not in env["result"]


def test_a_miss_is_ok_with_a_null_result_and_a_null_rung(tmp_path):
    """"No project holds this folder" is a complete, measured answer.

    It must not be a ``not_found`` (which would say the lookup does not
    exist) and must not be a ``cannot_determine`` (which would claim the
    server failed to evaluate a question it answered perfectly well).
    """
    env = project_for_cwd_result([_node(1, "/somewhere/else")], str(tmp_path))
    assert env["result_status"] == "ok"
    assert env["result"] is None
    assert env["meta"]["matched_by"] is None
    assert env["unevaluated"] == []


# --------------------------------------------------------------------------- #
# 4. The route.
# --------------------------------------------------------------------------- #


def _app() -> FastAPI:
    """An app carrying only the lookup router, auth overridden."""
    app = FastAPI()
    app.include_router(lookup_router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: True
    return app


@pytest.fixture()
def seeded_state(tmp_path, monkeypatch):
    """A migrated archive holding one project, wired into Settings.

    Never the real corpus: the state dir is a pytest tmp_path.

    Returns:
        The ``observed_cwd`` the seeded project was recorded under.
    """
    state = tmp_path / "state"
    ensure_db_migrated(state, 4, "0.8.2")
    observed = str(tmp_path / "seeded-project")
    conn = connect(db_path_for(state), create=False)
    with conn:
        conn.execute(
            "INSERT INTO message_hosts (id, machine_id, machine_id_scheme, "
            "display_name, hostname, platform, first_seen_at) VALUES "
            "(1, 'MID-1', 'platform_uuid', 'fixture-host', 'fixture', "
            "'Darwin 25.6.0', '2026-08-01T00:00:00.000000Z')"
        )
        conn.execute(
            "INSERT INTO message_corpora (id, host_id, corpus_key, root_path, "
            "collected_at, manifest_sha) VALUES "
            "(1, 1, 'claude-projects', '/fixture/projects', "
            "'2026-08-01T00:00:00.000000Z', NULL)"
        )
        conn.execute(
            "INSERT INTO message_projects (id, corpus_id, slug, observed_cwd, "
            "first_seen_at) VALUES "
            "(1, 1, '-seeded', ?, '2026-08-01T00:00:00.000000Z')",
            (observed,),
        )
    conn.close()

    from src.config import settings

    # Settings is a pydantic model, so an instance attribute cannot be
    # set. Patch the METHOD on the class, which is what the route
    # resolves through anyway.
    monkeypatch.setattr(type(settings), "get_state_dir", lambda self: state)
    return observed


def test_the_route_answers_the_seeded_project(seeded_state):
    """End to end: a real read, through the thread, into the envelope."""
    with TestClient(_app()) as client:
        response = client.get(LOOKUP_PATH, params={"cwd": seeded_state})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["result_status"] == "ok"
    assert body["result"]["project_id"] == 1
    assert body["result"]["matched_by"] == MATCH_EXACT


def test_the_route_answers_a_miss_as_ok_with_a_null_result(seeded_state):
    """A folder nobody has worked in is a 200, not a 404."""
    with TestClient(_app()) as client:
        response = client.get(LOOKUP_PATH, params={"cwd": "/no/such/folder"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["result_status"] == "ok"
    assert body["result"] is None
    assert body["meta"]["matched_by"] is None


def test_an_unopenable_datastore_is_cannot_determine_not_a_miss(
    tmp_path, monkeypatch,
):
    """THE DISTINCTION THIS WHOLE API IS BUILT ON, on this route too.

    A client that read a database fault as "this folder has no archived
    conversations" would hide the control and say something confident and
    false about the archive.
    """
    from src.config import settings

    empty = tmp_path / "no-such-state"
    empty.mkdir()
    monkeypatch.setattr(type(settings), "get_state_dir", lambda self: empty)

    with TestClient(_app()) as client:
        response = client.get(LOOKUP_PATH, params={"cwd": "/anything"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["result_status"] == "cannot_determine"
    assert body["result"] is None
    assert body["unevaluated"], "a refusal that names no subject is a silent one"


def test_the_route_requires_a_cwd(seeded_state):
    """A lookup with nothing to look up is a client error, not a miss."""
    with TestClient(_app()) as client:
        assert client.get(LOOKUP_PATH).status_code == 422
        assert client.get(LOOKUP_PATH, params={"cwd": ""}).status_code == 422


def test_the_route_carries_no_response_model_and_requires_auth():
    """The archive's two standing structural promises, on this router.

    A ``response_model`` is a FILTER: it would silently delete ``meta``
    and ``unevaluated``. And a project path is the owner's private
    directory layout, so the route is never anonymous.
    """
    routes = [r for r in lookup_router.routes if getattr(r, "path", "")]
    assert routes, "the router registered nothing"
    for route in routes:
        assert route.response_model is None, route.path
        assert any(
            getattr(dep.call, "__name__", "") == "require_auth"
            for dep in route.dependant.dependencies
        ), f"{route.path} is reachable without a token"


def test_the_path_is_not_served_when_the_router_is_not_mounted():
    """An install with the archive switched off 404s, like its siblings."""
    bare = FastAPI()
    bare.dependency_overrides[require_auth] = lambda: True
    with TestClient(bare) as client:
        assert client.get(LOOKUP_PATH, params={"cwd": "/x"}).status_code == 404


def test_the_mount_sits_inside_the_message_archive_flag_block():
    """And the mount really is gated, read from ``src/main.py``'s source.

    THE RUNTIME CHECK ABOVE CANNOT SEE THIS. ``MESSAGE_ARCHIVE`` is
    resolved at import time, so a test process can only ever observe the
    branch its own environment took; an include accidentally placed
    outside the block would still pass every request-level test on a box
    where the archive is enabled, and would quietly serve a lookup into a
    datastore the operator opted out of. So the gate is asserted
    STATICALLY, from the tree, the way
    ``tests/test_include_router_order.py`` asserts its own rule.
    """
    source = (ROOT / "src" / "main.py").read_text(encoding="utf-8")
    tree = ast.parse(source)

    guarded: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.If):
            continue
        test = node.test
        if not (
            isinstance(test, ast.Attribute)
            and test.attr == "enabled"
            and isinstance(test.value, ast.Name)
            and test.value.id == "MESSAGE_ARCHIVE"
        ):
            continue
        for inner in ast.walk(node):
            if (
                isinstance(inner, ast.Call)
                and isinstance(inner.func, ast.Attribute)
                and inner.func.attr == "include_router"
                and inner.args
                and isinstance(inner.args[0], ast.Name)
            ):
                guarded.append(inner.args[0].id)

    assert "archive_project_lookup_router" in guarded, (
        "the cwd lookup router is not included inside "
        "`if MESSAGE_ARCHIVE.enabled:`; an install that opted out of the "
        f"archive would still serve {LOOKUP_PATH}. Guarded includes "
        f"found: {guarded!r}"
    )
