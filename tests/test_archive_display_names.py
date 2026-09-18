"""The forward slug join, its tie-break, and the refusals that bound it.

THE NEGATIVE CONTROLS ARE THE POINT OF THIS FILE. A resolver that always
returns something would pass every positive test here and be worse than
no resolver at all, because the rail would then confidently render a name
for a directory nobody matched. So four cases must REFUSE, and one of
them - ``cannot_determine`` versus ``none`` - is the pair most likely to
be quietly collapsed by a later change, since both render as "no name"
and mean opposite things.

THE SYMLINK CASES USE A REAL SYMLINK. ``path_spellings`` calls
``os.path.realpath``, so a fake table cannot reproduce the behaviour under
test; a monkeypatched HOME with a genuine link in it can, and that is what
the ``symlinked_home`` fixture builds.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from src.core.archive_display_names import (
    MATCHED_AMBIGUOUS,
    MATCHED_AS_WRITTEN,
    MATCHED_CANNOT_DETERMINE,
    MATCHED_CANONICAL_SPELLING,
    MATCHED_NONE,
    ProjectNameIndex,
    naming_meta,
    resolve_slug,
    resolve_slugs,
)
from src.core.claude_transcript_correlate import slugify_project_dir


def _row(pid, root, name, raw=None, desc=None):
    """One projects row shaped as the index expects it."""
    return {
        "id": pid,
        "root": root,
        "raw_path": raw,
        "display_name": name,
        "description": desc,
    }


@pytest.fixture()
def symlinked_home(tmp_path, monkeypatch):
    """A HOME holding a real symlink, mirroring the owner's iCloud layout.

    Returns (home, long_dir, short_dir) where short_dir is the aliased
    spelling of the same real directory.
    """
    home = tmp_path / "home"
    real = home / "Library" / "Sync" / "Development"
    real.mkdir(parents=True)
    (real / "Hirschfeld").mkdir()
    link = home / "Development"
    os.symlink(real, link)
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))
    return home, str(real / "Hirschfeld"), str(link / "Hirschfeld")


# --- the join itself ------------------------------------------------------


def test_a_projects_own_spelling_resolves_as_written():
    """The common rung: the row's root slugifies to the archive's slug."""
    root = "/Users/x/Development/Media"
    index = ProjectNameIndex([_row(1, root, "Media")], complete=True, aliases=[])
    out = resolve_slug(index, slugify_project_dir(root))
    assert out["matched_by"] == MATCHED_AS_WRITTEN
    assert out["display_name"] == "Media"
    assert out["project_id"] == 1


def test_the_slug_is_never_parsed_so_lossy_names_still_resolve():
    """A folder whose own name holds '-', '_' and a space resolves exactly.

    Splitting the slug on '-' yields 'server', 'Work' and 'scripts' for
    these three; computing the slug forward yields the right row every
    time. This is the whole argument for the direction of the join.
    """
    rows = [
        _row(1, "/Users/x/Production/bhpp_new_server", "BHPP"),
        _row(2, "/Users/x/Development/3D Work", "3D Work"),
        _row(3, "/Users/x/Production/dev-tools/scripts", "Scripts"),
    ]
    index = ProjectNameIndex(rows, complete=True, aliases=[])
    for row in rows:
        out = resolve_slug(index, slugify_project_dir(row["root"]))
        assert out["display_name"] == row["display_name"]


def test_raw_path_resolves_as_well_as_root():
    """Both recorded spellings feed the index, not just ``root``."""
    index = ProjectNameIndex(
        [_row(1, "/Users/x/a", "A", raw="/Users/x/b")], complete=True, aliases=[]
    )
    assert resolve_slug(index, slugify_project_dir("/Users/x/b"))["display_name"] == "A"


def test_the_description_travels_with_the_name():
    """``description`` is surfaced, because it explains the duplicates."""
    index = ProjectNameIndex(
        [_row(1, "/Users/x/m", "Media", desc="Media pipeline (migrated)")],
        complete=True,
        aliases=[],
    )
    out = resolve_slug(index, slugify_project_dir("/Users/x/m"))
    assert out["description"] == "Media pipeline (migrated)"


# --- the cwd-spelling split ----------------------------------------------


def test_both_spellings_of_one_directory_answer_one_name(symlinked_home):
    """THE OWNER'S DEFECT. Two spellings must not become two projects.

    The live data holds 'Hirschfeld' rooted at the iCloud path and
    'Hirschfeld (old path)' rooted at the symlink, and both slugs match
    both rows. Ranking by how literally each row matched would answer
    'Hirschfeld (old path)' for the short slug. The canonical-root
    tie-break answers 'Hirschfeld' for BOTH, which is the fix.
    """
    _home, long_dir, short_dir = symlinked_home
    index = ProjectNameIndex(
        [_row(4, short_dir, "Hirschfeld (old path)"), _row(6, long_dir, "Hirschfeld")],
        complete=True,
    )
    for spelling in (long_dir, short_dir):
        out = resolve_slug(index, slugify_project_dir(spelling))
        assert out["display_name"] == "Hirschfeld", spelling
        assert out["project_id"] == 6
        assert out["candidate_count"] == 2


def test_the_aliased_spelling_is_reported_as_canonical_not_as_written(
    symlinked_home,
):
    """Provenance survives the tie-break: the rung says how it matched."""
    _home, long_dir, short_dir = symlinked_home
    index = ProjectNameIndex([_row(6, long_dir, "Hirschfeld")], complete=True)
    assert (
        resolve_slug(index, slugify_project_dir(long_dir))["matched_by"]
        == MATCHED_AS_WRITTEN
    )
    assert (
        resolve_slug(index, slugify_project_dir(short_dir))["matched_by"]
        == MATCHED_CANONICAL_SPELLING
    )


# --- NEGATIVE CONTROLS. These must refuse. -------------------------------


def test_an_unmatched_slug_is_a_measured_absence_and_carries_no_name():
    """NEGATIVE CONTROL. The resolver must not always find something."""
    index = ProjectNameIndex([_row(1, "/Users/x/a", "A")], complete=True, aliases=[])
    out = resolve_slug(index, "-Users-x-does-not-exist-anywhere")
    assert out["matched_by"] == MATCHED_NONE
    assert out["display_name"] is None
    assert out["description"] is None
    assert out["project_id"] is None


def test_an_unreadable_database_is_not_an_empty_one():
    """NEGATIVE CONTROL, and the pair most likely to be collapsed later.

    ``complete=False`` means nobody looked; ``complete=True`` with no rows
    means we looked and there is nothing. Both render as "no name" and
    only the second licenses the caller to say so.
    """
    slug = slugify_project_dir("/Users/x/a")
    assert (
        resolve_slug(ProjectNameIndex([], complete=False), slug)["matched_by"]
        == MATCHED_CANNOT_DETERMINE
    )
    assert (
        resolve_slug(ProjectNameIndex([], complete=True, aliases=[]), slug)["matched_by"]
        == MATCHED_NONE
    )


def test_an_unreadable_index_refuses_even_a_slug_it_would_have_matched():
    """A refusal outranks a hit; it is evaluated before any comparison."""
    root = "/Users/x/Media"
    index = ProjectNameIndex([_row(1, root, "Media")], complete=False, aliases=[])
    out = resolve_slug(index, slugify_project_dir(root))
    assert out["matched_by"] == MATCHED_CANNOT_DETERMINE
    assert out["display_name"] is None


def test_two_different_real_directories_on_one_slug_refuse(tmp_path):
    """NEGATIVE CONTROL. A real collision the slug cannot adjudicate.

    ``a_b`` and ``a-b`` are different directories that slugify to the
    same string. Picking either would be a coin toss rendered as a fact.
    """
    (tmp_path / "a_b").mkdir()
    (tmp_path / "a-b").mkdir()
    index = ProjectNameIndex(
        [
            _row(1, str(tmp_path / "a_b"), "Underscore"),
            _row(2, str(tmp_path / "a-b"), "Hyphen"),
        ],
        complete=True,
        aliases=[],
    )
    out = resolve_slug(index, slugify_project_dir(str(tmp_path / "a_b")))
    assert out["matched_by"] == MATCHED_AMBIGUOUS
    assert out["display_name"] is None
    assert out["candidate_count"] == 2


def test_two_non_canonical_roots_for_one_directory_refuse(symlinked_home):
    """The tie-break needs EXACTLY ONE canonical root, not at least one."""
    _home, _long, short_dir = symlinked_home
    index = ProjectNameIndex(
        [_row(1, short_dir, "One"), _row(2, short_dir, "Two")], complete=True
    )
    out = resolve_slug(index, slugify_project_dir(short_dir))
    assert out["matched_by"] == MATCHED_AMBIGUOUS
    assert out["display_name"] is None


def test_a_row_naming_no_folder_is_dropped_not_indexed_under_empty():
    """A project with no root cannot match, least of all an empty slug."""
    index = ProjectNameIndex([_row(1, None, "Nameless")], complete=True, aliases=[])
    assert index.project_count == 0
    assert resolve_slug(index, "")["matched_by"] == MATCHED_NONE


# --- the summary ----------------------------------------------------------


def test_naming_meta_counts_every_rung_separately():
    """``none`` and ``cannot_determine`` are never summed together."""
    root = "/Users/x/a"
    index = ProjectNameIndex([_row(1, root, "A")], complete=True, aliases=[])
    results = resolve_slugs(index, [slugify_project_dir(root), "-nope"])
    meta = naming_meta(index, results)
    assert meta["resolved"] == 1
    assert meta["slugs_considered"] == 2
    assert meta["by_match_kind"][MATCHED_NONE] == 1
    assert meta["by_match_kind"][MATCHED_CANNOT_DETERMINE] == 0
    assert meta["app_database_read"] is True


def test_naming_meta_reports_an_unread_database_as_unread():
    index = ProjectNameIndex([], complete=False)
    meta = naming_meta(index, resolve_slugs(index, ["-a", "-b"]))
    assert meta["app_database_read"] is False
    assert meta["resolved"] == 0
    assert meta["by_match_kind"][MATCHED_CANNOT_DETERMINE] == 2
