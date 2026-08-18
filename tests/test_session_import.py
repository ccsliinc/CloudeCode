"""The one-way import latch, and the failed probe that must never stamp it.

WHY THIS FILE EXISTS, IN ONE PARAGRAPH.
``meta.imported_from_json_at`` is stamped once and never cleared, over an
input that disappears: the live tmux process list. If the tmux probe fails
and the latch is stamped anyway, the import writes zero sessions, marks
itself complete forever, and the user boots to an empty RECENT list with
no error on any screen. His history is gone and nothing will ever retry.
That is the single most dangerous line in the whole datastore design, and
these tests are the thing standing on it.

TWO KINDS OF ASSERTION HERE, DELIBERATELY.
  BEHAVIOURAL - feed a failed listing, prove nothing was written and the
    latch is unset, then prove a later successful run completes.
  STRUCTURAL  - walk the module's AST and prove there is exactly ONE
    stamp site and that it is unreachable from the failed-probe branch.
The behavioural test only covers the paths it happens to exercise. The
structural one covers the edit somebody makes next year.
"""

from __future__ import annotations

import ast
import os
import sys
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DEFAULT_WORKING_DIR", "/tmp")
os.environ.setdefault("LOG_DIRECTORY", "/tmp")
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.db import connect, db_path_for, get_meta, transaction
from src.core.db_migration import ensure_db_migrated
from src.core.db_models import (
    META_IMPORTED_FROM_JSON_AT,
    META_SESSION_IMPORT_PENDING_REASON,
    SESSION_ATTRIBUTION_DERIVED_DEEPEST,
    SESSION_ATTRIBUTION_NONE,
    SESSION_ATTRIBUTION_UNKNOWN,
    SESSION_LIFECYCLE_RUNNING,
    SESSION_LIFECYCLE_STOPPED,
    SESSION_ORIGIN_ADOPTED,
    SESSION_ORIGIN_CREATED,
    SESSION_ORIGIN_OBSERVED,
)
from src.core.session_import import (
    IMPORT_ALREADY_DONE,
    IMPORT_COMPLETED,
    IMPORT_PENDING_LISTING_UNAVAILABLE,
    attribute_working_dir,
    run_first_run_import,
)
from src.core.session_store import count_sessions, list_sessions
from src.core.tmux_listing import (
    REASON_NO_SERVER,
    REASON_TIMEOUT,
    REASON_TMUX_MISSING,
    TmuxListing,
)

SESSION_IMPORT_PATH = ROOT / "src" / "core" / "session_import.py"


@dataclass
class FakeProject:
    """Minimal stand-in for ProjectConfig.

    Inputs (constructor): name (str), path (str), description (str|None),
      agent_type (str).
    Output: a FakeProject instance.
    """

    name: str
    path: str
    description: Optional[str] = None
    agent_type: str = "claude"


@pytest.fixture()
def conn(tmp_path):
    """A migrated cloude.db connection at the current schema version.

    Inputs: tmp_path (Path).
    Output: sqlite3.Connection, closed on teardown.
    """
    ensure_db_migrated(tmp_path, 4, "0.8.2")
    with closing(connect(db_path_for(tmp_path))) as connection:
        yield connection


def _live(name, epoch, working_dir=None):
    """Build one attachable-listing row.

    Inputs: name (str), epoch (int), working_dir (str | None).
    Output: dict.
    """
    row = {"name": name, "created_at_epoch": epoch, "window_count": 1}
    if working_dir is not None:
        row["working_dir"] = working_dir
    return row


def _run(conn, listing, **kwargs):
    """Run the first-run import inside its own transaction.

    Inputs: conn (sqlite3.Connection). listing (TmuxListing).
      **kwargs - forwarded to run_first_run_import.
    Output: FirstRunImportResult.
    """
    kwargs.setdefault("projects", [])
    with transaction(conn):
        return run_first_run_import(conn, listing=listing, **kwargs)


# ===========================================================================
# THE MOST IMPORTANT TEST IN THE PLAN
# ===========================================================================


@pytest.mark.parametrize(
    "reason", [REASON_TIMEOUT, REASON_TMUX_MISSING, "exit_2", "probe_error"]
)
def test_a_failed_probe_imports_nothing_and_LEAVES_THE_LATCH_UNSET(conn, reason):
    """ok=False must import zero sessions and never stamp the latch.

    If this test ever fails, a user upgrading on a machine where tmux
    happened to be unreachable for one second loses every session he has,
    permanently and silently. There is no error path, no retry and no
    second chance: the JSON files stay on disk and nothing reads them
    again.
    """
    result = _run(conn, TmuxListing.unavailable(reason))

    assert result.outcome == IMPORT_PENDING_LISTING_UNAVAILABLE
    assert result.pending is True
    assert result.sessions_imported == 0
    assert count_sessions(conn) == 0, "a failed probe wrote session rows"
    assert get_meta(conn, META_IMPORTED_FROM_JSON_AT) is None, (
        "THE LATCH WAS STAMPED ON A FAILED PROBE. The import can never "
        "run again on this install and the user's session history is gone"
    )
    # the third outcome is NAMED, not blank and not invented
    assert result.listing_reason == reason
    assert get_meta(conn, META_SESSION_IMPORT_PENDING_REASON) == reason
    notice = result.home_screen_notice()
    assert notice is not None and "PENDING" in notice and reason in notice


def test_a_later_successful_run_completes_the_import(conn):
    """The retry must actually work, or the guard is just a slower loss."""
    first = _run(conn, TmuxListing.unavailable(REASON_TIMEOUT))
    assert first.pending is True
    assert count_sessions(conn) == 0

    second = _run(
        conn,
        TmuxListing.answered([_live("cloude_a", 1000), _live("b", 2000)]),
        owned_tmux_names={"cloude_a"},
    )

    assert second.outcome == IMPORT_COMPLETED
    assert second.sessions_imported == 2
    assert count_sessions(conn) == 2
    assert get_meta(conn, META_IMPORTED_FROM_JSON_AT) is not None


def test_NO_CODE_PATH_STAMPS_THE_LATCH_ON_THE_FAILED_PROBE_BRANCH():
    """The structural half: assert the negative directly, in the AST.

    Two facts, both mechanical:
      1. session_import.py contains EXACTLY ONE call that stamps
         META_IMPORTED_FROM_JSON_AT.
      2. That call is textually AFTER the ``if not listing.ok:`` guard,
         and that guard's body returns - so the stamp is unreachable from
         the failed-probe branch.

    A behavioural test can only fail on inputs somebody thought to try.
    This one fails on the EDIT, which is the actual risk: the whole
    danger is a future change that adds a second stamp or hoists this one
    above the gate.
    """
    source = SESSION_IMPORT_PATH.read_text()
    tree = ast.parse(source)

    stamps = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = getattr(func, "id", None) or getattr(func, "attr", None)
        if name != "set_meta":
            continue
        for arg in node.args:
            if getattr(arg, "id", None) == "META_IMPORTED_FROM_JSON_AT" or (
                getattr(arg, "value", None) == "imported_from_json_at"
            ):
                stamps.append(node.lineno)

    assert len(stamps) == 1, (
        f"expected exactly ONE latch stamp in session_import.py, found "
        f"{len(stamps)} at lines {stamps}. Every extra one is a path that "
        "can mark the import complete without having done it"
    )

    # locate the gate: the `if not listing.ok:` whose body returns
    gates = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.If):
            continue
        test = node.test
        if (
            isinstance(test, ast.UnaryOp)
            and isinstance(test.op, ast.Not)
            and getattr(test.operand, "attr", None) == "ok"
        ):
            returns = any(
                isinstance(inner, ast.Return) for inner in ast.walk(node)
            )
            assert returns, "the listing.ok gate does not return"
            gates.append((node.lineno, node.end_lineno))

    assert len(gates) == 1, f"expected one listing.ok gate, found {gates}"
    gate_start, gate_end = gates[0]
    assert stamps[0] > gate_end, (
        f"the latch stamp is at line {stamps[0]}, which is NOT after the "
        f"failed-probe gate ending at line {gate_end}. It is reachable "
        "before the probe has been shown to have succeeded"
    )

    # and nothing inside the gate's body writes a session row either
    gate_body = "\n".join(source.splitlines()[gate_start - 1:gate_end])
    assert "record_instance" not in gate_body, (
        "the failed-probe branch writes session rows"
    )


def test_pending_notice_is_absent_on_every_non_pending_outcome(conn):
    """A notice's PRESENCE must mean act, so it must not appear otherwise."""
    completed = _run(conn, TmuxListing.answered([]))
    assert completed.outcome == IMPORT_COMPLETED
    assert completed.home_screen_notice() is None

    again = _run(conn, TmuxListing.answered([]))
    assert again.outcome == IMPORT_ALREADY_DONE
    assert again.home_screen_notice() is None


def test_no_server_is_a_real_answer_of_zero_and_DOES_complete(conn):
    """ok=True with reason='no_server' is tmux answering, not failing.

    A tmux server exits when its last session ends, so this is the normal
    steady state of a machine with no sessions. Treating it as a failed
    probe would leave the latch unset forever on exactly the machines
    with nothing to import.
    """
    result = _run(conn, TmuxListing.answered([], reason=REASON_NO_SERVER))
    assert result.outcome == IMPORT_COMPLETED
    assert get_meta(conn, META_IMPORTED_FROM_JSON_AT) is not None


# ===========================================================================
# idempotence
# ===========================================================================


def test_importing_twice_with_ok_true_does_not_duplicate_rows(conn):
    """The second run is a no-op, not a second copy of every session."""
    listing = TmuxListing.answered([_live("cloude_a", 1000), _live("b", 2000)])
    first = _run(conn, listing, owned_tmux_names={"cloude_a"})
    assert first.sessions_imported == 2

    second = _run(conn, listing, owned_tmux_names={"cloude_a"})
    assert second.outcome == IMPORT_ALREADY_DONE
    assert second.sessions_imported == 0
    assert count_sessions(conn) == 2


def test_the_projects_stage_does_not_double_on_a_retry(conn):
    """A failed probe re-runs the projects stage; it must stay idempotent."""
    projects = [FakeProject(name="p1", path="/tmp/p1")]
    _run(conn, TmuxListing.unavailable(REASON_TIMEOUT), projects=projects)
    _run(conn, TmuxListing.answered([]), projects=projects)
    rows = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
    assert rows == 1


# ===========================================================================
# origin: created only from the legacy owned set, adopted never
# ===========================================================================


def test_origin_is_created_only_when_the_name_is_in_the_owned_set(conn):
    """Design 5.3 step 4, both halves."""
    _run(
        conn,
        TmuxListing.answered([_live("mine", 1000), _live("theirs", 2000)]),
        owned_tmux_names={"mine"},
    )
    by_name = {row["tmux_name"]: row for row in list_sessions(conn)}
    assert by_name["mine"]["origin"] == SESSION_ORIGIN_CREATED
    assert by_name["theirs"]["origin"] == SESSION_ORIGIN_OBSERVED


def test_NOTHING_is_ever_imported_as_adopted(conn):
    """Past adoptions were never persisted, so importing one invents a fact.

    Checked across every input shape the import accepts, because the
    tempting bug is to "helpfully" restore an adoption from a legacy
    ``adopted:`` id prefix, which is not evidence of anything - a restart
    mints that prefix for sessions the app CREATED.
    """
    _run(
        conn,
        TmuxListing.answered([_live("a", 1), _live("b", 2), _live("c", 3)]),
        owned_tmux_names={"a"},
        persisted_sessions=[
            {"tmux_session": "b", "id": "adopted:b", "agent_type": "claude"},
            {"tmux_session": "gone", "id": "adopted:gone"},
        ],
    )
    origins = {row["origin"] for row in list_sessions(conn)}
    assert SESSION_ORIGIN_ADOPTED not in origins, (
        f"the import claimed an adoption it has no evidence for: {origins}"
    )
    assert origins == {SESSION_ORIGIN_CREATED, SESSION_ORIGIN_OBSERVED}
    assert all(row["adopted_at"] is None for row in list_sessions(conn))


def test_a_persisted_session_with_no_live_tmux_row_becomes_RECENT(conn):
    """Design 5.3 step 5 - this is what gives RECENT its first row."""
    result = _run(
        conn,
        TmuxListing.answered([_live("live", 1000)]),
        persisted_sessions=[
            {
                "tmux_session": "dead",
                "id": "sess-123",
                "agent_type": "codex",
                "pinned_theme": "dracula",
            }
        ],
    )
    by_name = {row["tmux_name"]: row for row in list_sessions(conn)}
    assert by_name["live"]["lifecycle"] == SESSION_LIFECYCLE_RUNNING
    assert by_name["dead"]["lifecycle"] == SESSION_LIFECYCLE_STOPPED
    assert by_name["dead"]["agent_type"] == "codex"
    assert by_name["dead"]["pinned_theme"] == "dracula"
    assert by_name["dead"]["legacy_session_id"] == "sess-123"
    assert result.unmatched == [
        {"tmux_session": "dead", "reason": "no_live_tmux_row"}
    ]


# ===========================================================================
# attribution: unknown is not none
# ===========================================================================


def test_an_unprobeable_working_dir_is_unknown_and_never_guessed(conn):
    """Obligation: unprobeable cwd -> 'unknown', into NEEDS ATTENTION.

    Not 'none', which would claim we looked, and not the nearest project,
    which would claim we found something.
    """
    _run(
        conn,
        TmuxListing.answered([_live("no-cwd", 1000)]),
        projects=[FakeProject(name="p", path="/tmp/p")],
    )
    row = list_sessions(conn)[0]
    assert row["project_attribution"] == SESSION_ATTRIBUTION_UNKNOWN
    assert row["project_id"] is None


def test_attribution_picks_the_DEEPEST_matching_root():
    """Deepest wins, and a sibling prefix is not a match."""
    roots = {"/a": 1, "/a/b": 2}
    assert attribute_working_dir("/a/b/c", roots) == (
        2, SESSION_ATTRIBUTION_DERIVED_DEEPEST,
    )
    assert attribute_working_dir("/a/x", roots) == (
        1, SESSION_ATTRIBUTION_DERIVED_DEEPEST,
    )
    # component matching, not string prefix: /a/bc is NOT under /a/b
    assert attribute_working_dir("/a/bc", roots) == (
        1, SESSION_ATTRIBUTION_DERIVED_DEEPEST,
    )
    assert attribute_working_dir("/elsewhere", roots) == (
        None, SESSION_ATTRIBUTION_NONE,
    )
    assert attribute_working_dir(None, roots) == (
        None, SESSION_ATTRIBUTION_UNKNOWN,
    )
    assert attribute_working_dir("", roots) == (
        None, SESSION_ATTRIBUTION_UNKNOWN,
    )


def test_a_probed_working_dir_attributes_to_its_project(conn):
    """The happy path, via the inline working_dir the listing carried."""
    _run(
        conn,
        TmuxListing.answered([_live("a", 1000, working_dir="/tmp/p/sub")]),
        projects=[FakeProject(name="p", path="/tmp/p")],
    )
    row = list_sessions(conn)[0]
    assert row["project_attribution"] == SESSION_ATTRIBUTION_DERIVED_DEEPEST
    assert row["project_id"] is not None


def test_the_working_dir_probe_callback_is_used_when_the_row_lacks_one(conn):
    """A probe that answers None must yield 'unknown', not a guess."""
    _run(
        conn,
        TmuxListing.answered([_live("a", 1), _live("b", 2)]),
        projects=[FakeProject(name="p", path="/tmp/p")],
        working_dir_probe=lambda name: "/tmp/p" if name == "a" else None,
    )
    by_name = {row["tmux_name"]: row for row in list_sessions(conn)}
    assert by_name["a"]["project_attribution"] == (
        SESSION_ATTRIBUTION_DERIVED_DEEPEST
    )
    assert by_name["b"]["project_attribution"] == SESSION_ATTRIBUTION_UNKNOWN


# ===========================================================================
# collisions during import
# ===========================================================================


def test_an_epoch_collision_during_import_is_recorded_not_swallowed(conn):
    """A refused merge must surface in the result, not vanish."""
    _run(conn, TmuxListing.answered([_live("foo", 1000)]))
    with transaction(conn):
        conn.execute(
            "UPDATE sessions SET lifecycle = ? WHERE tmux_name = 'foo'",
            (SESSION_LIFECYCLE_STOPPED,),
        )
        conn.execute(
            "UPDATE meta SET value = json_remove(value, '$.sessions_imported_at') "
            "WHERE key = 'imported_from_json_result'"
        )
        conn.execute("DELETE FROM meta WHERE key = ?", (META_IMPORTED_FROM_JSON_AT,))

    result = _run(conn, TmuxListing.answered([_live("foo", 1000)]))
    assert len(result.refusals) == 1
    assert result.refusals[0]["tmux_name"] == "foo"
    assert result.refusals[0]["tmux_created_epoch"] == 1000
    assert count_sessions(conn) == 1
