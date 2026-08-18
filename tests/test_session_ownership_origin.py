"""The created_by_cloude cutover: sessions.origin is now the source of truth.

WHAT CHANGED. Ownership used to be membership of the in-memory
``owned_tmux_sessions`` set, rebuilt from a live listing on every start,
which is why an adoption could not survive a restart. It is now
``sessions.origin``, a stored column anchored on the tmux INSTANCE triple
``(socket, name, creation epoch)``.

WHY THE EPOCH IS IN EVERY ASSERTION HERE. The badge decides whether the
user is told a session is HIS. A name-keyed lookup gets that wrong the
moment a name is reused, and a session the user never touched shows up
badged as his. So the tests below always check the reused-name case, not
just the happy one.

WHAT DID NOT CHANGE, DELIBERATELY. ``owned_tmux_sessions`` is still
maintained and still consulted, and the adopt ROUTE still does not write
``origin='adopted'`` - persisting adoption is build step S7. Cutting that
over here would flip the badge for adopted sessions and break
scripts/verify_session_ownership_badge.py, which must pass unchanged
across this commit.
"""

from __future__ import annotations

import ast
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DEFAULT_WORKING_DIR", "/tmp")
os.environ.setdefault("LOG_DIRECTORY", "/tmp")
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.tmux_backend import TmuxBackend

SESSION_MANAGER_PATH = ROOT / "src" / "core" / "session_manager.py"
TMUX_BACKEND_PATH = ROOT / "src" / "core" / "tmux_backend.py"


class _FakeProbeBackend:
    """A TmuxBackend whose listing rows are supplied, not shelled out for.

    Description: exercises the real resolution logic in
      ``list_attachable_sessions`` without running tmux, so the test can
      state an exact (name, epoch) pair. Never touches a socket.
    Inputs (constructor): rows (list[tuple[str, int]]) - name and epoch.
    Output: an object with ``list_attachable_sessions``.
    """

    def __init__(self, rows):
        self._rows = rows

    def _run_listing(self, *_args):
        """Return the canned tmux stdout for the supplied rows.

        Inputs: *_args - ignored.
        Output: tuple[None, str] - (no failure, formatted stdout).
        """
        text = "\n".join(f"{name}|{epoch}|1" for name, epoch in self._rows)
        return None, text

    list_attachable_sessions = TmuxBackend.list_attachable_sessions


def _badges(rows, **kwargs):
    """Resolve created_by_cloude for each row through the real backend code.

    Inputs: rows (list[tuple[str, int]]). **kwargs - owned_names and/or
      owned_instances, forwarded verbatim.
    Output: dict[str, bool] - tmux name -> created_by_cloude.
    """
    listing = _FakeProbeBackend(rows).list_attachable_sessions(**kwargs)
    assert listing.ok
    return {row["name"]: row["created_by_cloude"] for row in listing.sessions}


# --- the instance tier ------------------------------------------------------


def test_ownership_resolves_on_the_INSTANCE_not_the_name():
    """A reused name must not inherit the previous instance's badge.

    The scenario, concretely: the app owned a session called ``foo``. It
    died. The user made a brand new, unrelated ``foo``. Only the epoch
    tells them apart, and getting this wrong badges a stranger's process
    as the user's own.
    """
    badges = _badges(
        [("foo", 2000), ("bar", 3000)],
        owned_instances={("foo", 1000)},
    )
    assert badges["foo"] is False, (
        "the reused name inherited the dead instance's ownership badge"
    )
    assert badges["bar"] is False


def test_the_matching_instance_does_badge_as_ours():
    """The other half: same name AND same epoch is the same session."""
    badges = _badges([("foo", 1000)], owned_instances={("foo", 1000)})
    assert badges["foo"] is True


def test_a_legacy_name_with_no_epoch_still_matches_by_name():
    """(name, None) entries carry the in-memory set through the cutover.

    ``owned_tmux_sessions`` holds names and no creation times, so it
    cannot be instance-keyed. It contributes with a wildcard epoch, which
    keeps the badge from regressing while both sources coexist.
    """
    badges = _badges([("foo", 9999)], owned_instances={("foo", None)})
    assert badges["foo"] is True


def test_owned_instances_takes_precedence_over_owned_names():
    """Most specific tier wins, or the lossy answer would mask the exact one."""
    badges = _badges(
        [("foo", 2000)],
        owned_names={"foo"},
        owned_instances={("foo", 1000)},
    )
    assert badges["foo"] is False


def test_the_name_tier_still_works_when_no_instances_are_supplied():
    """Back-compat: a caller with only names behaves exactly as before."""
    badges = _badges([("foo", 2000), ("bar", 1)], owned_names={"foo"})
    assert badges == {"foo": True, "bar": False}


def test_an_empty_instance_set_means_nothing_is_owned_not_fall_back():
    """An EMPTY set is an answer; None is the absence of one.

    Collapsing the two would make "the DB says this app owns nothing"
    silently reopen the spoofable prefix heuristic.
    """
    badges = _badges([("cloude_x", 1)], owned_instances=set())
    assert badges["cloude_x"] is False


def test_with_neither_source_the_prefix_heuristic_still_applies():
    """Unchanged fallback for callers outside the live app path."""
    badges = _badges([("cloude_x", 1), ("other", 2)])
    assert badges == {"cloude_x": True, "other": False}


# --- the structural guarantees ---------------------------------------------


def test_the_ownership_decision_lives_in_ONE_place_in_session_manager():
    """No call site may re-derive ownership from the raw legacy set.

    The original bug survived because three call sites answered this
    question three different ways, so the badge could be right on one
    screen and wrong on another. Every read now funnels through
    ``is_owned_tmux_name`` / ``owned_tmux_instances``, and the raw
    ``in self.owned_tmux_sessions`` membership test is allowed ONLY
    inside those helpers.
    """
    source = SESSION_MANAGER_PATH.read_text()
    tree = ast.parse(source)

    # The resolver itself, plus the three sites that legitimately touch
    # the legacy set for something that is NOT a badge. Each is named with
    # its reason so widening this list is a deliberate act:
    #
    #   rename_session          name-COLLISION avoidance, and re-keying the
    #                           set itself. Both are set maintenance, not
    #                           "is this session ours".
    #   destroy_external_session discards a name from the set. Maintenance.
    #
    # These disappear with the set itself in the follow-up commit.
    allowed = {
        "is_owned_tmux_name",
        "owned_tmux_instances",
        "rename_session",
        "destroy_external_session",
    }

    offenders = []
    for func in ast.walk(tree):
        if not isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if func.name in allowed:
            continue
        for node in ast.walk(func):
            if not isinstance(node, ast.Compare):
                continue
            if not any(isinstance(op, ast.In) for op in node.ops):
                continue
            for comparator in node.comparators:
                if getattr(comparator, "attr", None) == "owned_tmux_sessions":
                    offenders.append((func.name, node.lineno))

    assert offenders == [], (
        "these functions test membership of owned_tmux_sessions directly "
        f"instead of going through the shared resolver: {offenders}. That "
        "is exactly how the badge came to disagree with itself before"
    )


def test_owned_tmux_sessions_is_still_alive_this_commit():
    """S4 must NOT delete the legacy set - that is a separate follow-up.

    It is removed only after scripts/verify_session_ownership_badge.py has
    passed against the DB as the source of truth. Deleting it in the same
    commit that introduces its replacement leaves no way to tell a
    cutover bug from a removal bug.
    """
    source = SESSION_MANAGER_PATH.read_text()
    assert "self.owned_tmux_sessions: set[str] = set()" in source
    assert 'payload["owned_tmux_sessions"] = sorted(self.owned_tmux_sessions)' in source


def test_the_adopt_route_does_not_persist_origin_yet():
    """Persisting adoption is S7. Doing it here breaks the shipped verifier.

    session_store.adopt_instance exists and is tested, but nothing in
    session_manager may call it yet: the badge for an adopted session
    would flip to owned and
    scripts/verify_session_ownership_badge.py - which must pass unchanged
    across this commit - asserts it stays external.
    """
    source = SESSION_MANAGER_PATH.read_text()
    assert "adopt_instance" not in source, (
        "session_manager calls adopt_instance, which persists origin. That "
        "is build step S7 and it flips the ownership badge for adopted "
        "sessions; the shipped badge verifier asserts the opposite"
    )


def test_the_backend_resolution_order_is_documented_in_code():
    """The three tiers must be visible where the decision is made."""
    source = TMUX_BACKEND_PATH.read_text()
    assert "if owned_instances is not None:" in source
    assert "created_by_cloude = name in owned_names" in source
    assert "created_by_cloude = name.startswith(SESSION_PREFIX)" in source


def test_no_em_or_en_dashes_in_the_files_this_step_authored():
    """House style, checked by codepoint rather than by grep.

    grep here is a shell function that behaves like -I and silently skips
    files it deems binary, so an empty grep is not evidence of absence.
    """
    authored = [
        ROOT / "src" / "core" / "session_store.py",
        ROOT / "src" / "core" / "session_import.py",
        Path(__file__),
        ROOT / "tests" / "test_session_store.py",
        ROOT / "tests" / "test_session_import.py",
    ]
    for path in authored:
        text = path.read_text(encoding="utf-8")
        assert text.count(chr(8212)) == 0, f"em-dash in {path.name}"
        assert text.count(chr(8211)) == 0, f"en-dash in {path.name}"
