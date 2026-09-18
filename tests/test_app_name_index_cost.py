"""The naming pass opens ONE connection, and the count is the assertion.

WHY A COUNT AND NOT A CLOCK. This project has twice shipped a per-row
database open - 33 connections for 11 rows on ``/sessions/attachable``,
95 per pass on ``/sessions/list`` - and both times the symptom was a
latency tail, not a wrong answer. A wall-clock assertion on a loaded box
either flakes or is too loose to catch a regression from 1 open to N. The
COUNT is the defect exactly, so that is what is pinned.

The bound is a CONSTANT, deliberately. If a later change makes the naming
pass open a connection per project, this file fails with the number it
opened, and raising the bound to make it pass is re-introducing the
defect with the alarm switched off.
"""

from __future__ import annotations

import sqlite3

import pytest

from src.core import app_name_index as module
from src.core.app_name_index import empty_index, load_app_name_index
from src.core.archive_display_names import MATCHED_CANNOT_DETERMINE, resolve_slug

#: One open for the whole index, whatever the row count. Never per row.
MAX_OPENS_PER_PASS = 1


@pytest.fixture()
def counting_connect(monkeypatch):
    """Count every ``connect`` the naming pass makes."""
    calls = []
    real = module.connect

    def spy(path, **kwargs):
        calls.append(kwargs)
        return real(path, **kwargs)

    monkeypatch.setattr(module, "connect", spy)
    return calls


def _make_db(path, projects, sessions=()):
    """Build a minimal cloude.db holding only what the index reads."""
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE projects (id INTEGER PRIMARY KEY, root TEXT, "
        "raw_path TEXT, display_name TEXT, description TEXT)"
    )
    conn.execute(
        "CREATE TABLE sessions (id INTEGER PRIMARY KEY, "
        "claude_session_uuid TEXT, title TEXT)"
    )
    conn.executemany(
        "INSERT INTO projects (id, root, raw_path, display_name, description) "
        "VALUES (?,?,?,?,?)",
        projects,
    )
    conn.executemany(
        "INSERT INTO sessions (claude_session_uuid, title) VALUES (?,?)", sessions
    )
    conn.commit()
    conn.close()


def test_one_open_for_many_projects(tmp_path, counting_connect):
    """Fifty projects cost the same one connection as one project does."""
    rows = [(i, f"/Users/x/p{i}", None, f"P{i}", None) for i in range(1, 51)]
    _make_db(tmp_path / "cloude.db", rows)
    index = load_app_name_index(tmp_path)
    assert index.complete is True
    assert index.projects.project_count == 50
    assert len(counting_connect) <= MAX_OPENS_PER_PASS, (
        f"the naming pass opened {len(counting_connect)} connections for 50 "
        f"projects; the bound is {MAX_OPENS_PER_PASS} for any row count"
    )


def test_the_connection_does_not_attach_the_archive(tmp_path, counting_connect):
    """LOCK SCOPE. Attaching would put both files under one write lock.

    That is the shape ``db_connection_shape`` forbids and the shape that
    produced the 516-second hold in issue #224, so it is asserted at the
    seam rather than established by reading the call graph once.
    """
    _make_db(tmp_path / "cloude.db", [(1, "/Users/x/a", None, "A", None)])
    load_app_name_index(tmp_path)
    assert counting_connect, "expected the index to open a connection"
    assert all(k.get("attach_archive") is False for k in counting_connect)
    assert all(k.get("create") is False for k in counting_connect)


def test_a_missing_database_degrades_to_cannot_determine(tmp_path):
    """NEGATIVE CONTROL. No file means nobody looked, not nothing found.

    A missing cloude.db must not read as "this archive has no projects",
    which is a lie with the same shape as the truth.
    """
    index = load_app_name_index(tmp_path / "nowhere")
    assert index.complete is False
    assert resolve_slug(index.projects, "-Users-x-a")["matched_by"] == (
        MATCHED_CANNOT_DETERMINE
    )


def test_a_database_without_the_columns_degrades_rather_than_raising(tmp_path):
    """An older install is a reason to name nothing, never to 500."""
    conn = sqlite3.connect(tmp_path / "cloude.db")
    conn.execute("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)")
    conn.commit()
    conn.close()
    index = load_app_name_index(tmp_path)
    assert index.complete is False
    assert index.session_title("anything") is None


def test_session_titles_are_read_in_the_same_pass(tmp_path, counting_connect):
    """Names for both surfaces come from ONE open, not one each."""
    _make_db(
        tmp_path / "cloude.db",
        [(1, "/Users/x/a", None, "A", None)],
        sessions=[("uuid-1", "Media Compression"), ("uuid-2", "Hirschfeld")],
    )
    index = load_app_name_index(tmp_path)
    assert index.session_title("uuid-1") == "Media Compression"
    assert index.session_title_count == 2
    assert len(counting_connect) <= MAX_OPENS_PER_PASS


def test_an_unread_index_never_hands_back_a_session_title():
    """NEGATIVE CONTROL. A refusal must not leak a name from anywhere."""
    assert empty_index().session_title("uuid-1") is None
