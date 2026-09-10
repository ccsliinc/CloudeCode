"""Regression guard: every document in ``docs/`` is routable from CLAUDE.md.

WHY THIS EXISTS. CLAUDE.md is the only entry point guaranteed to be loaded by
an agent working in this tree. Measured 2026-09-10, before the index table was
added, it named 4 of the 27 files in ``docs/``. The other 23 were invisible to
a clean-context agent, which then re-derived what they already said or
contradicted it. ``docs/DECISIONS.md`` was on that list, and it holds standing
rulings that bind every agent, so an agent that never learned the file existed
could re-remove a feature the owner had explicitly ruled stays.

The decay is silent and it is the whole problem: a new document is written,
nobody adds a row for it, and it is unreachable from the day it lands with no
signal anywhere that it happened. That is why this is a test rather than a note
asking people to remember. Same shape and same reasoning as
``tests/test_no_remote_assets.py``.

WHAT IT DOES NOT CLAIM. A row existing is not a row being accurate. This test
proves the path is named in CLAUDE.md; it cannot prove the sentence beside it
still describes the file. Gotcha 8 covers that half, and only a human can.

If this test fails, the fix is to add a row to the table in CLAUDE.md under
"Every document in ``docs/``, and when to read it", saying in one line WHEN to
read the new file. Do not delete the document, and do not satisfy the test by
mentioning the path somewhere unrelated.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
CLAUDE_MD = REPO_ROOT / "CLAUDE.md"
DOCS_DIR = REPO_ROOT / "docs"


def _claude_md_text() -> str:
    """Read the project instructions file.

    Returns:
        str: full text of CLAUDE.md.
    """
    if not CLAUDE_MD.is_file():
        pytest.skip(f"CLAUDE.md not found at {CLAUDE_MD}, nothing to check")
    return CLAUDE_MD.read_text(encoding="utf-8", errors="replace")


def _docs_markdown_files() -> list[Path]:
    """List the top-level markdown documents in ``docs/``.

    Only the top level is checked. Subdirectories under ``docs/`` hold assets,
    images, screenshots and vendored skill copies, none of which are prose an
    agent routes to, and sweeping them would make the table a file listing
    rather than a routing layer.

    Returns:
        list[Path]: every ``docs/*.md`` path, sorted, for stable failure text.
    """
    if not DOCS_DIR.is_dir():
        pytest.skip(f"docs/ not found at {DOCS_DIR}, nothing to check")
    return sorted(DOCS_DIR.glob("*.md"))


def test_every_docs_file_is_named_in_claude_md() -> None:
    """Fail with the exact list of documents CLAUDE.md does not route to.

    The reference is checked as the repo-relative path (``docs/name.md``)
    because that is what a reader can act on: a bare filename in prose does
    not tell an agent where the file is, and the table is written with the
    full path for that reason.
    """
    text = _claude_md_text()
    docs = _docs_markdown_files()
    assert docs, "docs/ holds no markdown files, which is not an expected state"

    missing = [
        f"docs/{path.name}"
        for path in docs
        if f"docs/{path.name}" not in text
    ]

    assert not missing, (
        "These files in docs/ are not named in CLAUDE.md, so a clean-context "
        "agent cannot find them:\n  "
        + "\n  ".join(missing)
        + "\n\nAdd a row for each to the table in CLAUDE.md under "
        '"Every document in `docs/`, and when to read it", with one line '
        "saying WHEN to read it. A filename alone is not a routing entry. "
        "Do not delete or move the document to make this pass."
    )


def test_the_index_does_not_route_to_documents_that_are_gone() -> None:
    """The reverse direction: a row must not outlive the file it points at.

    A stale row is worse than a missing one. It sends an agent to read a file
    that is not there, and unlike a missing row it looks like the index is
    complete. Only paths under ``docs/`` ending in ``.md`` are checked, so a
    reference to ``docs/`` itself or to an asset directory is untouched.

    A token carrying a wildcard is a PATTERN, not a reference. ``docs/*.md``
    is how the file names the set, and reading it as a filename would make
    this test fail on the sentence that describes its own rule.
    """
    wildcard_chars = set("*?[]<>")
    text = _claude_md_text()
    docs = _docs_markdown_files()
    on_disk = {f"docs/{path.name}" for path in docs}

    referenced: set[str] = set()
    for token in text.replace("`", " ").replace("(", " ").replace(")", " ").split():
        cleaned = token.strip(".,:;\"'|")
        if wildcard_chars & set(cleaned):
            continue
        if cleaned.startswith("docs/") and cleaned.endswith(".md"):
            # Only top-level docs are in scope; a nested path is a different
            # claim and this test does not police it.
            if cleaned.count("/") == 1:
                referenced.add(cleaned)

    dangling = sorted(referenced - on_disk)

    assert not dangling, (
        "CLAUDE.md points at these documents, which do not exist on disk:\n  "
        + "\n  ".join(dangling)
        + "\n\nEither restore the file or remove the reference. A reference to "
        "a file that is gone sends the next agent looking for prose that was "
        "deleted, and reads as though the index is complete."
    )
