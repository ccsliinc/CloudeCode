"""ADVERSARIAL demonstrations against build step S4 (feat/sessions-table).

Every test in this file DEMONSTRATES A DEFECT. They are written to fail
in the sense that matters - each one asserts the CURRENT, WRONG
behaviour, and names in its docstring what the correct behaviour would
be - so that a fix flips the assertion rather than deleting the test.

Read the module as a list of ways the S4 guarantees can be defeated
WITHOUT editing src/core/session_import.py, which is the only module the
AST test constrains.
"""

from __future__ import annotations

import os
import sqlite3
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
    SESSION_LIFECYCLE_RUNNING,
    SESSION_LIFECYCLE_STOPPED,
    SESSION_ORIGIN_ADOPTED,
    SESSION_ORIGIN_CREATED,
    SESSION_ORIGIN_OBSERVED,
)
from src.core.session_identity import (
    RECORD_MERGED,
    adopt_instance,
    record_instance,
)
from src.core.session_import import IMPORT_COMPLETED, run_first_run_import
from src.core.session_store import count_sessions, list_sessions
from src.core.tmux_listing import (
    TmuxListing,
    classify_listing_failure,
    looks_like_no_server,
)


@dataclass
class FakeProject:
    """Minimal stand-in for ProjectConfig.

    Inputs (constructor): name (str), path (str), agent_type (str).
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


# ---------------------------------------------------------------------------
# DEFECT 1 - the latch IS stamped on a probe that could not answer.
#
# The AST test constrains src/core/session_import.py. It cannot constrain
# the CLASSIFIER that decides whether a failed tmux invocation is
# ok=False (no answer) or ok=True (a complete answer of zero).
#
# looks_like_no_server() matches the bare substring "error connecting to"
# and ignores the errno in the parentheses entirely. tmux emits that same
# prefix for Permission denied, Socket operation on non-socket, and File
# name too long - all measured against tmux 3.5a on this machine. Each of
# those is a probe that DID NOT ANSWER, and each is classified as ok=True
# with zero sessions, which walks straight through the gate and stamps
# the one-way latch.
# ---------------------------------------------------------------------------

REAL_TMUX_STDERR_THAT_IS_NOT_NO_SERVER = (
    "error connecting to /tmp/advt/noperm/sock2 (Permission denied)",
    "error connecting to /tmp/advt/noperm/sock (Socket operation on non-socket)",
    "error connecting to /very/long/path/sock (File name too long)",
)


@pytest.mark.parametrize("stderr_text", REAL_TMUX_STDERR_THAT_IS_NOT_NO_SERVER)
def test_defect_probe_failure_misclassified_as_zero_sessions(stderr_text):
    """A tmux connect ERROR is classified as a complete answer of zero.

    Description: DEFECT. These three stderr strings were produced by real
      tmux 3.5a invocations. None of them means "no server is running";
      each means "I could not reach the socket". CORRECT behaviour is
      ok=False. Current behaviour is ok=True with sessions=[].
    """
    assert looks_like_no_server(stderr_text) is True  # WRONG
    listing = classify_listing_failure(1, stderr_text)
    assert listing.ok is True  # WRONG - should be False
    assert listing.sessions == []
    assert listing.reason == "no_server"


def test_defect_latch_stamped_after_unreadable_socket(conn):
    """A permission-denied socket stamps the latch and loses history forever.

    Description: DEFECT, and it is the exact catastrophe
      session_import.py's docstring says cannot happen. The user has live
      tmux sessions; the probe cannot reach the socket; tmux says
      "error connecting to ... (Permission denied)"; the classifier calls
      that a complete answer of zero; the gate passes; zero sessions are
      imported; imported_from_json_at is STAMPED; the import never runs
      again on this install. CORRECT behaviour is a PENDING outcome with
      the latch unset.
    """
    listing = classify_listing_failure(
        1, "error connecting to /tmp/x/sock (Permission denied)"
    )
    result = run_first_run_import(conn, projects=[], listing=listing)
    assert result.outcome == IMPORT_COMPLETED  # WRONG - should be PENDING
    assert result.sessions_imported == 0
    assert count_sessions(conn) == 0
    assert get_meta(conn, META_IMPORTED_FROM_JSON_AT) is not None  # WRONG
    assert result.home_screen_notice() is None  # WRONG - user sees nothing

    # And it is now permanent: the real sessions can never be imported.
    second = run_first_run_import(
        conn,
        projects=[],
        listing=TmuxListing.answered([_live("cloude_work", 1755000000)]),
        owned_tmux_names={"cloude_work"},
    )
    assert second.outcome == "already_done"
    assert count_sessions(conn) == 0  # his session history, gone


# ---------------------------------------------------------------------------
# DEFECT 2 - the instance triple is FORGEABLE from a tmux session name.
#
# TmuxBackend.list_attachable_sessions asks tmux for
# "#{session_name}|#{session_created}|#{session_windows}" and splits the
# line on "|". tmux forbids only "." and ":" in a session name - "|" is
# legal, verified on tmux 3.5a. _sanitize_tmux_name replaces only "." and
# ":" too, so the app itself will happily mint a name containing pipes
# from a project called "a|b".
# ---------------------------------------------------------------------------


def _parse_listing_line(line, owned_instances=None):
    """Replicate TmuxBackend.list_attachable_sessions' row parser exactly.

    Description: the parser lives inside a method that shells out to
      tmux, so it is reproduced here verbatim rather than mocked, to show
      what the real code does with a real tmux line.
    Inputs: line (str) - one line of tmux -F output. owned_instances
      (set | None).
    Output: dict - the row the backend would emit.
    """
    parts = line.split("|")
    name, created_raw, windows_raw = parts[0], parts[1], parts[2]
    try:
        created_at_epoch = int(created_raw)
    except ValueError:
        created_at_epoch = 0
    owned = False
    if owned_instances is not None:
        owned = (
            (name, created_at_epoch) in owned_instances
            or (name, None) in owned_instances
        )
    return {"name": name, "created_at_epoch": created_at_epoch, "owned": owned}


def test_defect_pipe_in_tmux_name_forges_the_instance_triple():
    """A session named "victim|1755000000|1" impersonates an owned instance.

    Description: DEFECT. Measured tmux output for a session created as
      `tmux new-session -s 'victim|1755000000|1'` is
      `victim|1755000000|1|1787070480|1`. The parser takes fields 0,1,2,
      so the app believes it is looking at a session named "victim"
      created at epoch 1755000000 - an instance triple the attacker
      chose. If the DB holds an owned row for that triple, the unrelated
      process badges as OURS. CORRECT behaviour is to reject a name
      containing the delimiter, or to use a delimiter tmux cannot emit
      inside a name (e.g. a NUL or a multi-character sentinel).
    """
    real_tmux_line = "victim|1755000000|1|1787070480|1"
    owned_from_db = {("victim", 1755000000)}
    row = _parse_listing_line(real_tmux_line, owned_instances=owned_from_db)
    assert row["name"] == "victim"  # WRONG - the real name has pipes in it
    assert row["created_at_epoch"] == 1755000000  # WRONG - real epoch 1787070480
    assert row["owned"] is True  # WRONG - this is not the owned session


def test_defect_sanitize_tmux_name_permits_the_delimiter():
    """The app mints its own pipe-containing names, no attacker required.

    Description: DEFECT. _sanitize_tmux_name documents that tmux forbids
      only "." and ":" and preserves everything else verbatim. A project
      named "api|prod" therefore yields a tmux name the app's own listing
      parser cannot read back.
    """
    from src.core.session_manager import _sanitize_tmux_name

    assert _sanitize_tmux_name("api|prod") == "api|prod"  # WRONG for this parser


# ---------------------------------------------------------------------------
# DEFECT 3 - the legacy owned-name set is UNIONed in with a wildcard
# epoch, which defeats the epoch tier for exactly the sessions the epoch
# tier was added to protect.
# ---------------------------------------------------------------------------


def test_defect_legacy_wildcard_epoch_defeats_the_instance_key():
    """A reused tmux name still badges as ours, exactly as before S4.

    Description: DEFECT. SessionManager.owned_tmux_instances() returns
      `db_instances | {(name, None) for name in owned_tmux_sessions}`,
      and TmuxBackend matches `(name, None) in owned_instances` as a
      name-only wildcard. So for every name still in the legacy
      in-memory set - which is every session this app created since the
      last restart - the epoch is ignored and a NEW, unrelated tmux
      session that took the name badges as OURS. That is verbatim the
      failure the commit message says the epoch "closes entirely", and
      tmux_backend's own docstring claims is fixed.
    """
    owned_from_db = {("cloude_work", 1755000000)}
    legacy_names = {"cloude_work"}
    combined = owned_from_db | {(n, None) for n in legacy_names}

    # The old session died. A brand new, unrelated session took the name.
    stranger = _parse_listing_line(
        "cloude_work|1787070999|1", owned_instances=combined
    )
    assert stranger["created_at_epoch"] == 1787070999  # a different instance
    assert stranger["owned"] is True  # WRONG - should be False

    # With the legacy wildcard removed, the epoch tier works as designed.
    correct = _parse_listing_line(
        "cloude_work|1787070999|1", owned_instances=owned_from_db
    )
    assert correct["owned"] is False


# ---------------------------------------------------------------------------
# DEFECT 4 - the same-second collision guard only fires on a STOPPED row,
# which is the rarer half of the case. The common half MERGES.
# ---------------------------------------------------------------------------


def test_defect_adoption_transfers_to_a_stranger_on_a_running_row(conn):
    """An adopted session's identity is handed to a different process.

    Description: DEFECT. record_instance REFUSES only when the stored row
      is already `stopped`. A row is marked stopped by a successful
      probe, and probes are periodic - so in the window between a
      session's death and the next probe, the stored row is still
      `running`. A new session that takes the same name inside the same
      one-second epoch therefore MERGES into the adopted row, inheriting
      its session_uuid, its origin='adopted' and its adopted_at. The user
      sees a session badged as his that he never claimed - the exact
      user-facing catastrophe design 4.6 names. CORRECT behaviour is to
      refuse the merge on a colliding triple whenever the app has any
      evidence the stored instance is not the live one, or to widen the
      identity beyond a one-second epoch (tmux exposes
      #{session_id}, e.g. "$3", which is unique per server lifetime).
    """
    with transaction(conn):
        record_instance(
            conn,
            socket="cloude",
            name="cloude_work",
            epoch=1755000000,
            origin=SESSION_ORIGIN_CREATED,
            lifecycle=SESSION_LIFECYCLE_RUNNING,
        )
        adopt_instance(
            conn, socket="cloude", name="cloude_work", epoch=1755000000,
            now="2026-08-18T00:00:00Z",
        )
    before = list_sessions(conn)[0]
    assert before["origin"] == SESSION_ORIGIN_ADOPTED

    # The session dies. NO probe has run yet, so the row is still running.
    # A completely unrelated process takes the name inside the same second.
    with transaction(conn):
        result = record_instance(
            conn,
            socket="cloude",
            name="cloude_work",
            epoch=1755000000,
            origin=SESSION_ORIGIN_OBSERVED,
            lifecycle=SESSION_LIFECYCLE_RUNNING,
        )
    assert result.outcome == RECORD_MERGED  # WRONG - should be refused
    after = list_sessions(conn)[0]
    assert after["session_uuid"] == before["session_uuid"]
    assert after["origin"] == SESSION_ORIGIN_ADOPTED  # WRONG - stranger badged ours
    assert after["adopted_at"] == "2026-08-18T00:00:00Z"


def test_defect_adopt_instance_can_claim_a_dead_session(conn):
    """adopt_instance has no lifecycle guard, so a stale UI adopts a corpse.

    Description: DEFECT (lower severity). The UPDATE keys on the triple
      alone. A client holding a listing from before the session died can
      POST /sessions/adopt and permanently mark a stopped row as adopted.
      CORRECT behaviour is to require the row be `running`, or at least
      to report which lifecycle it claimed.
    """
    with transaction(conn):
        record_instance(
            conn, socket="cloude", name="dead", epoch=1755000000,
            origin=SESSION_ORIGIN_OBSERVED,
            lifecycle=SESSION_LIFECYCLE_STOPPED,
        )
        claimed = adopt_instance(
            conn, socket="cloude", name="dead", epoch=1755000000
        )
    assert claimed is True  # WRONG - nothing live was claimed
    assert list_sessions(conn)[0]["origin"] == SESSION_ORIGIN_ADOPTED


# ---------------------------------------------------------------------------
# DEFECT 5 - the import badges the user's own persisted session EXTERNAL.
# ---------------------------------------------------------------------------


def test_defect_persisted_owned_session_imports_as_observed(conn):
    """The one session RECENT is built from imports with origin='observed'.

    Description: DEFECT. session_import step 5 hardcodes
      `origin=SESSION_ORIGIN_OBSERVED` for a persisted session with no
      live tmux row, ignoring owned_tmux_names entirely - unlike step 4,
      which consults it. session_metadata.json holds exactly ONE session:
      the most recently active one, which for this user is almost always
      one the app created. So on the very upgrade this import exists to
      protect, his last session appears in RECENT badged EXTERNAL.
      CORRECT behaviour is observed_origin_for(name, owned), the same
      resolver step 4 uses.
    """
    result = run_first_run_import(
        conn,
        projects=[],
        listing=TmuxListing.answered([]),
        owned_tmux_names={"cloude_mine"},
        persisted_sessions=[
            {"tmux_session": "cloude_mine", "id": "sess-1",
             "agent_type": "claude", "tmux_created_epoch": 1755000000},
        ],
    )
    assert result.outcome == IMPORT_COMPLETED
    row = list_sessions(conn)[0]
    assert row["tmux_name"] == "cloude_mine"
    assert row["lifecycle"] == SESSION_LIFECYCLE_STOPPED
    assert row["origin"] == SESSION_ORIGIN_OBSERVED  # WRONG - should be created


# ---------------------------------------------------------------------------
# DEFECT 6 - main.py never tells the import which socket it probed.
# ---------------------------------------------------------------------------


def test_defect_import_hardcodes_the_default_socket(conn):
    """Rows record tmux_socket='cloude' whatever socket was actually probed.

    Description: DEFECT. src/main.py calls run_first_run_import without
      `socket=`, so every imported row takes DEFAULT_TMUX_SOCKET. A user
      with `session.tmux_socket_name` set to anything else gets rows
      asserting an instance that does not exist on that socket, while
      SessionManager._tmux_socket_name() reads the CONFIGURED value back
      - so owned_instances() queries socket='mysock', finds nothing, and
      the ownership badge silently falls back to the legacy name set for
      that whole install. CORRECT behaviour is to pass the same socket
      the probe used.
    """
    run_first_run_import(
        conn,
        projects=[],
        listing=TmuxListing.answered([_live("cloude_a", 1755000000)]),
        owned_tmux_names={"cloude_a"},
    )
    import inspect

    import src.main as main_mod
    from src.core import session_import
    from src.core.session_store import owned_instances

    # main.py never passes socket=, so the row takes the module default,
    # not the socket the probe ran against and not the configured one.
    main_src = inspect.getsource(main_mod)
    call = main_src[main_src.index("run_first_run_import("):]
    call = call[: call.index("\n                    )")]
    assert "socket=" not in call  # WRONG - the probed socket is dropped

    default = inspect.signature(
        session_import.run_first_run_import
    ).parameters["socket"].default
    assert isinstance(default, str) and default  # a module constant, not a probe
    assert list_sessions(conn)[0]["tmux_socket"] == default

    # A differently-configured socket therefore finds nothing, and the
    # badge silently falls back to the legacy name set for that install.
    assert owned_instances(conn, socket="some-other-socket") == set()


# ---------------------------------------------------------------------------
# DEFECT 7 - an unparseable result blob silently un-does the once-only
# guard, and clobbers the other stages' records.
# ---------------------------------------------------------------------------


def test_defect_corrupt_result_blob_reruns_the_import(conn):
    """A garbled meta blob makes the once-only import run a second time.

    Description: DEFECT (contained, but it is a third outcome collapsed
      into a pass). sessions_stage_done() reads
      meta.imported_from_json_result and treats an unparseable value as
      ABSENT - i.e. as proof the stage has not run - which is exactly the
      "could not evaluate reported as a verdict" the repo rule forbids.
      The re-run does not double rows (the unique index and the refusal
      hold), but _merge_result_blob then writes a fresh blob and DISCARDS
      every key the corrupt one held. CORRECT behaviour is to refuse to
      proceed on an unreadable latch record and say so.
    """
    from src.core.db import set_meta
    from src.core.db_models import META_IMPORTED_FROM_JSON_RESULT
    from src.core.session_import import sessions_stage_done

    with transaction(conn):
        run_first_run_import(
            conn, projects=[], listing=TmuxListing.answered([]),
        )
    assert sessions_stage_done(conn) is True

    with transaction(conn):
        set_meta(conn, META_IMPORTED_FROM_JSON_RESULT, "{not json")
    assert sessions_stage_done(conn) is False  # WRONG - unreadable, not absent

    with transaction(conn):
        again = run_first_run_import(
            conn, projects=[], listing=TmuxListing.answered([]),
        )
    assert again.outcome == IMPORT_COMPLETED  # ran a second time


# ---------------------------------------------------------------------------
# DEFECT 8 - the AST proof guards the DECORATIVE latch, not the OPERATIVE one.
#
# The once-only guard that actually runs is sessions_stage_done(), which
# reads RESULT_KEY_SESSIONS_STAGE out of meta.imported_from_json_result
# and is written by _merge_result_blob(). META_IMPORTED_FROM_JSON_AT - the
# only thing the AST test constrains - is never read by the guard at all.
# So the mutation the AST test exists to catch is catchable in the wrong
# variable, and its twin walks straight past.
# ---------------------------------------------------------------------------


def test_defect_ast_proof_misses_the_guard_that_actually_latches(tmp_path):
    """Hoisting _merge_result_blob above the gate latches, and the AST test passes.

    Description: DEFECT. This mutates a COPY of session_import.py -
      moving the _merge_result_blob stamp above the `if not listing.ok`
      gate while leaving set_meta(META_IMPORTED_FROM_JSON_AT) exactly
      where it is - then shows (a) the mutant permanently latches the
      import on a failed probe, and (b) the structural AST assertions
      still hold on it. CORRECT behaviour is for the AST test to
      constrain every write that sessions_stage_done() can observe, or
      for the operative guard and the asserted latch to be the same key.
    """
    import ast

    src = (ROOT / "src" / "core" / "session_import.py").read_text()

    # The AST test's two structural assertions, evaluated on the mutant.
    def _structural_ok(source: str) -> bool:
        tree = ast.parse(source)
        stamps = [
            n.lineno
            for n in ast.walk(tree)
            if isinstance(n, ast.Call)
            and (getattr(n.func, "id", None) or getattr(n.func, "attr", None))
            == "set_meta"
            and any(
                getattr(a, "id", None) == "META_IMPORTED_FROM_JSON_AT"
                for a in n.args
            )
        ]
        gates = [
            (n.lineno, n.end_lineno)
            for n in ast.walk(tree)
            if isinstance(n, ast.If)
            and isinstance(n.test, ast.UnaryOp)
            and isinstance(n.test.op, ast.Not)
            and getattr(n.test.operand, "attr", None) == "ok"
        ]
        return len(stamps) == 1 and len(gates) == 1 and stamps[0] > gates[0][1]

    assert _structural_ok(src) is True  # the real module passes

    # THE MUTATION: stamp the operative guard key BEFORE the gate.
    hoist = (
        "    # --- step 3: THE GATE ---"
        "-----------------------------------------\n"
        "    _merge_result_blob(conn, {RESULT_KEY_SESSIONS_STAGE: stamp})\n"
    )
    marker = "    # --- step 3: THE GATE ------------------------------------------------\n"
    assert marker in src
    mutant = src.replace(marker, hoist, 1)

    assert _structural_ok(mutant) is True  # WRONG - the mutation is invisible

    # BEHAVIOURAL HALF, without needing the mutant loaded: the guard
    # sessions_stage_done() reads a key the AST test never mentions, and
    # the route reports a DIFFERENT key. Write only the guard key and the
    # import is latched shut while every reader says it never completed.
    import json

    from src.core.db import set_meta
    from src.core.db_models import META_IMPORTED_FROM_JSON_RESULT
    from src.core.session_import import (
        RESULT_KEY_SESSIONS_STAGE,
        sessions_stage_done,
    )

    ensure_db_migrated(tmp_path, 4, "0.8.2")
    with closing(connect(db_path_for(tmp_path))) as c:
        with transaction(c):
            set_meta(
                c,
                META_IMPORTED_FROM_JSON_RESULT,
                json.dumps({RESULT_KEY_SESSIONS_STAGE: "2026-08-18T00:00:00Z"}),
            )
        assert sessions_stage_done(c) is True  # latched
        # ...but the latch GET /sessions/import-status reports is unset,
        # so every reader says the import has not completed while the
        # import will in fact never run again.
        assert get_meta(c, META_IMPORTED_FROM_JSON_AT) is None  # WRONG

        with transaction(c):
            blocked = run_first_run_import(
                c,
                projects=[],
                listing=TmuxListing.answered([_live("cloude_work", 1755000000)]),
                owned_tmux_names={"cloude_work"},
            )
        assert blocked.outcome == "already_done"
        assert count_sessions(c) == 0
