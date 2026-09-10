"""The kept-behaviours guard, and the negative controls that make it mean anything.

WHAT IS BEING GUARDED. `docs/KEPT-BEHAVIOURS.md` carries the rule that neither
party removes something on the other party's kept list without agreement.
`scripts/check_kept_behaviours.py` is the mechanism: each behaviour declares
ANCHORS, short literals it rests on, and the guard fires when one is gone from
every declared path that still exists.

THE POSITIVE TEST ALONE IS WORTHLESS HERE, and this file is arranged around
that. A guard that can never fire passes "the tree is clean" perfectly, for
ever, and this project has already paid for a ladder rung that had never been
observed to fire. So the load-bearing tests are the ones that MUTATE a tree and
demand a finding, and the ones that mutate a DIFFERENT behaviour and demand
silence about the first.

MEASURED AGAINST THE REAL INCIDENT, not only against fixtures. Run over the
tree of `8898f07` (adoom666's "a session row action menu, and no more
double-click rename"), the guard names all four behaviours the two incidents
removed - restart on a live row, the manual mark-unread control, group filing
from the row, and double-click rename - and says nothing about the other four
entries in the same file. That replay is in the commit message rather than
here, because a test may not depend on a commit being reachable in the clone.

ONE THING THE BUILD OF THIS TAUGHT, and it is why `_ANCHOR_MUST_BE_A_CALL_SITE`
exists below. The first anchors for double-click rename were `dblclick` and
`beginEdit`, and they did NOT fire on `8898f07`: the commit deleted the gesture
while leaving prose about it in the module header, and kept `beginEdit` because
F2 still calls it. An anchor that matches a comment is a guard that reports a
behaviour as alive because someone wrote its name down. An anchor has to be a
call site.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import List

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
KEPT_DIR = REPO_ROOT / "docs" / "kept-behaviours"
OURS = KEPT_DIR / "ccsliinc.md"
_CHECKER_PATH = REPO_ROOT / "scripts" / "check_kept_behaviours.py"


def _load_checker():
    """Import the operator script as a module.

    `scripts/` is not a package, so the checker is loaded by path rather than
    duplicated here. One implementation, run the same way by the operator and
    by the suite; two copies would drift the moment either changed.

    Returns:
        module: scripts/check_kept_behaviours.py.
    """
    spec = importlib.util.spec_from_file_location("_kept_behaviours_check", _CHECKER_PATH)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        pytest.fail(f"cannot load {_CHECKER_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


CHECK = _load_checker()

#: Written out so the reason survives the next person reading this file.
_ANCHOR_MUST_BE_A_CALL_SITE = (
    "an anchor names a call site, not a word. A literal that also appears in "
    "prose keeps matching after the behaviour is deleted."
)


def _fatal(findings) -> List:
    """The findings that should fail a build.

    Args:
        findings: whatever `CHECK.run` returned.

    Returns:
        list: only the fatal ones.
    """
    return [f for f in findings if f.fatal]


def _write_tree(root: Path, files: dict) -> None:
    """Materialise a throwaway repo.

    Args:
        root: directory to build under.
        files: repo-relative path -> text content.
    """
    for rel, text in files.items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")


_FIXTURE_DOC = """# party: behaviours we rely on

## kept

### the first behaviour
paths: src/alpha.py
anchors: ALPHA_CALL_SITE
tests: tests/test_alpha.py
Prose about alpha.

### the second behaviour
paths: src/beta.py
anchors: BETA_CALL_SITE
tests: none
Prose about beta.

## disliked

### something we merely dislike
paths: src/nowhere_at_all.py
This is a preference and must never be guarded.
"""


def _fixture_files(alpha: str = "x = ALPHA_CALL_SITE()\n",
                   beta: str = "y = BETA_CALL_SITE()\n") -> dict:
    """A minimal two-behaviour repo the guard should be silent about.

    Args:
        alpha: contents of src/alpha.py.
        beta: contents of src/beta.py.

    Returns:
        dict: repo-relative path -> text.
    """
    return {
        "docs/kept-behaviours/party.md": _FIXTURE_DOC,
        "src/alpha.py": alpha,
        "src/beta.py": beta,
        "tests/test_alpha.py": "# holds alpha\n",
    }


# =====================================================================
# The quiet case, on the real tree
# =====================================================================

def test_the_real_tree_produces_no_fatal_finding():
    """The guard is silent on this repo as it stands.

    This is the assertion that has to hold on every commit. It is also the one
    that proves nothing on its own, which is what the mutation tests below are
    for.
    """
    findings, counted = CHECK.run(root=REPO_ROOT)
    assert counted > 0, "no kept behaviours were parsed at all"
    assert _fatal(findings) == [], "\n".join(f.render() for f in _fatal(findings))


def test_our_own_file_declares_paths_anchors_and_tests_for_every_entry():
    """ccsliinc holds itself to a complete declaration.

    A missing field is not fatal for anyone (adoom666's first commit of his own
    file must not fail on a convention he never agreed to), so this test is
    what applies the higher bar to OUR file only, without imposing it.
    """
    entries = CHECK.parse_party_file(OURS)
    assert entries, "ccsliinc.md parsed to zero entries"
    incomplete = [
        e.title for e in entries
        if not e.paths or e.anchors is None or e.tests is None
    ]
    assert incomplete == [], f"entries missing a declared field: {incomplete}"


def test_the_no_test_gap_is_recorded_rather_than_hidden(tmp_path):
    """A behaviour nothing holds says so, and the guard counts it - never
    fatally.

    Double-click rename USED TO be the running example here (it was the
    behaviour the merge nearly deleted and the one whose GESTURE no test
    exercised, since the rename tests called `beginEdit` directly). It no
    longer is: `tests/test_session_sidebar_rename_gesture.node.mjs` drives the
    real `addEventListener('dblclick', ...)` registration and its entry in
    `ccsliinc.md` now names that file. So this test uses the synthetic fixture
    instead - `_FIXTURE_DOC`'s "second behaviour" declares `tests: none` on
    purpose - to keep proving the general rule: recording `tests: none` is the
    honest answer for a behaviour nothing holds, inventing a test that does
    not cover the real gesture would be worse than the gap, and `--strict`
    deliberately does not fail a build over an honestly stated one.
    """
    _write_tree(tmp_path, _fixture_files())
    findings, _ = CHECK.run(root=tmp_path)
    gaps = [f for f in findings if f.kind == "NO_TEST"]
    assert [f.title for f in gaps] == ["the second behaviour"]
    assert all(not f.fatal for f in gaps), "a stated gap must never fail a build"

    entries = {e.title: e for e in CHECK.parse_party_file(OURS)}
    rename = next(t for t in entries if t.startswith("double-click rename"))
    assert entries[rename].tests == ["tests/test_session_sidebar_rename_gesture.node.mjs"], \
        "the rename entry must name the gesture test that closed its gap"


# =====================================================================
# NEGATIVE CONTROLS - the guard must actually be able to fire
# =====================================================================

def test_removing_an_anchor_fires_and_names_that_behaviour(tmp_path):
    """Delete the call site alpha rests on; the guard must name alpha.

    THIS IS THE LOAD-BEARING TEST. Without it the suite cannot tell a working
    guard from one whose search scope is wrong, whose parser silently produced
    zero entries, or which reads its own documentation and finds every anchor
    inside the file that declares it.
    """
    _write_tree(tmp_path, _fixture_files(alpha="x = something_else()\n"))
    findings, counted = CHECK.run(root=tmp_path)
    assert counted == 2, "the disliked section must not be parsed as a behaviour"
    fatal = _fatal(findings)
    assert [f.kind for f in fatal] == ["MISSING_ANCHOR"], \
        "\n".join(f.render() for f in findings)
    assert fatal[0].title == "the first behaviour"


def test_removing_one_anchor_says_nothing_about_the_other_behaviour(tmp_path):
    """The complement of the test above: it must not smear.

    A guard that reports every behaviour whenever any one breaks is a guard
    whose output nobody reads, which is the same outcome as no guard.
    """
    _write_tree(tmp_path, _fixture_files(beta="y = gone()\n"))
    fatal = _fatal(CHECK.run(root=tmp_path)[0])
    assert [f.title for f in fatal] == ["the second behaviour"]


def test_deleting_every_declared_path_fires(tmp_path):
    """A behaviour whose files are all gone is a finding, not a pass."""
    files = _fixture_files()
    del files["src/alpha.py"]
    _write_tree(tmp_path, files)
    fatal = _fatal(CHECK.run(root=tmp_path)[0])
    assert [f.kind for f in fatal] == ["ALL_PATHS_MISSING"]
    assert fatal[0].title == "the first behaviour"


def test_a_path_absent_on_this_branch_alone_is_not_a_finding(tmp_path):
    """Per-path absence must stay quiet, or the guard is noisy on a clean tree.

    Measured reason: `web/src/lib/plugins/mark-unread/index.ts`,
    `web/src/lib/StatusLed.svelte` and `web/src/lib/led.ts` are real declared
    paths that live on `feat/svelte-1.3-on-121` and are absent from this
    branch. Firing per-path would produce three findings on an untouched tree.
    """
    doc = _FIXTURE_DOC.replace(
        "paths: src/alpha.py",
        "paths: src/alpha.py web/src/lib/not-on-this-branch.ts")
    files = _fixture_files()
    files["docs/kept-behaviours/party.md"] = doc
    _write_tree(tmp_path, files)
    assert _fatal(CHECK.run(root=tmp_path)[0]) == []


def test_a_named_test_that_no_longer_exists_fires(tmp_path):
    """A stale test reference is worse than an honest gap, so it is fatal."""
    files = _fixture_files()
    del files["tests/test_alpha.py"]
    _write_tree(tmp_path, files)
    fatal = _fatal(CHECK.run(root=tmp_path)[0])
    assert [f.kind for f in fatal] == ["MISSING_TEST_FILE"]


# =====================================================================
# Symmetry - the other party's file must not fail on arrival
# =====================================================================

def test_an_entry_declaring_no_anchors_is_reported_and_never_fatal(tmp_path):
    """adoom666's first commit of his own file must not break the build.

    The policy is symmetric and it is useless with one side filled in, so the
    cost of adding a file has to be near zero. An entry with `paths:` alone is
    reported UNGUARDED, which is true and actionable, and fails nothing.
    """
    doc = _FIXTURE_DOC.replace("anchors: ALPHA_CALL_SITE\ntests: tests/test_alpha.py\n", "")
    files = _fixture_files()
    files["docs/kept-behaviours/party.md"] = doc
    _write_tree(tmp_path, files)
    findings, _ = CHECK.run(root=tmp_path)
    assert _fatal(findings) == []
    assert {"UNGUARDED", "NO_TESTS_FIELD"} <= {f.kind for f in findings}


def test_every_party_file_in_the_directory_is_read(tmp_path):
    """A new party file is guarded the day it lands, with no change here."""
    files = _fixture_files()
    files["docs/kept-behaviours/other.md"] = (
        "## kept\n\n### their behaviour\npaths: src/beta.py\n"
        "anchors: NOT_PRESENT_ANYWHERE\ntests: none\n")
    _write_tree(tmp_path, files)
    fatal = _fatal(CHECK.run(root=tmp_path)[0])
    assert [(f.party, f.kind) for f in fatal] == [("other", "MISSING_ANCHOR")]


# =====================================================================
# Could-not-scan is not a pass
# =====================================================================

def test_a_missing_kept_directory_raises_rather_than_passing(tmp_path):
    """An empty result and a deleted directory must not look the same.

    Same discipline as `scripts/scan_secrets.py`, whose exit 2 means
    could-not-scan. A guard that reports clean because it found nothing to
    check is how the rule dies quietly.
    """
    with pytest.raises(CHECK.KeptBehavioursError):
        CHECK.run(root=tmp_path)
