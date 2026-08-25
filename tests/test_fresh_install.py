"""What a genuinely fresh install is allowed to contain.

WHY THIS FILE EXISTS

Four first-run defects shipped in v1.0.2 and every one of them survived a
green suite, because nothing in the suite ever exercised an empty machine.
Every test here had a developer's populated ``config.json`` sitting next to
it, so "the user has four projects" and "the user has zero projects" were
never distinguishable.

The specific defect this file's first test would have caught: the bootstrap
(``macOS/bootstrap.js``, step 3e) copies ``config.example.json`` verbatim to
``config.json``. The example carried four invented demo projects pointing at
``~/projects/*`` paths that exist on nobody's machine, so the first screen a
new user ever saw was four broken rows.

The rule this file enforces: ``config.example.json`` documents the SHAPE of
the file. It is never a source of user DATA. A key whose value is a list of
things the user owns (projects) must ship empty, because the bootstrap copies
it verbatim and cannot tell an illustration from a real entry.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

#: Keys in config.example.json whose value is a collection of things the USER
#: owns, rather than a setting describing how the app behaves. The bootstrap
#: copies this file verbatim, so anything listed here must ship empty or a
#: fresh install starts with fabricated user data.
USER_DATA_KEYS = ("projects",)


@pytest.fixture(scope="module")
def example() -> dict:
    """Parsed config.example.json.

    Returns:
        The example config as a dict.
    """
    return json.loads((REPO_ROOT / "config.example.json").read_text())


@pytest.mark.parametrize("key", USER_DATA_KEYS)
def test_example_config_seeds_no_user_data(example: dict, key: str) -> None:
    """A user-data key must be present (shape) and empty (no fake rows).

    Present, so the file still documents that the key exists and is a list.
    Empty, so ``fs.copyFileSync(config.example.json, config.json)`` cannot
    hand a brand-new user rows they did not create.

    Args:
        example: Parsed config.example.json.
        key: The user-data key under test.
    """
    assert key in example, (
        f"{key} vanished from config.example.json. The example must still "
        f"document the key's existence and type, or the file stops being a "
        f"description of the file's shape."
    )
    assert example[key] == [], (
        f"config.example.json seeds {len(example[key])} {key}. The bootstrap "
        f"copies this file verbatim to config.json, so every entry here "
        f"becomes a row on a brand-new user's very first screen, pointing at "
        f"a path that exists only on the machine of whoever wrote it."
    )


def test_example_config_documents_project_shape_in_prose(example: dict) -> None:
    """Emptying ``projects`` must not delete the documentation of its shape.

    A bare ``"projects": []`` tells a reader the key exists and nothing about
    what goes in it. The shape has to survive somewhere the bootstrap will not
    copy into the user's data - a ``_comment_`` key, which the loader ignores.
    """
    comment = example.get("_comment_projects")
    assert isinstance(comment, str) and comment.strip(), (
        "config.example.json has no _comment_projects. Emptying the projects "
        "list removed the only illustration of a project's fields, so the "
        "example no longer documents the shape it exists to document."
    )
    for field in ("name", "path", "description", "agent_type"):
        assert field in comment, (
            f"_comment_projects does not mention the {field!r} field, so a "
            f"reader cannot learn a project's shape from this file."
        )


def test_fresh_config_json_yields_zero_projects(tmp_path: Path) -> None:
    """Reproduce the bootstrap copy and assert the result has no projects.

    This is the actual first-run path, not a restatement of the test above:
    ``macOS/bootstrap.js`` step 3e does a byte copy of the example to
    ``config.json`` when none exists. Asserting on the COPY is what proves a
    fresh install starts empty, because the copy is what the server reads.

    Args:
        tmp_path: pytest-provided empty directory standing in for a fresh
            install's config location.
    """
    fresh = tmp_path / "config.json"
    fresh.write_bytes((REPO_ROOT / "config.example.json").read_bytes())
    loaded = json.loads(fresh.read_text())
    assert loaded.get("projects") == [], (
        "A freshly bootstrapped config.json contains projects. The first "
        "screen of a brand-new install would show rows the user never made."
    )
