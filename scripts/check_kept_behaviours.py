#!/usr/bin/env python3
"""Guard: a kept behaviour may not vanish from the tree without anyone noticing.

WHY THIS EXISTS, AND WHY IT IS THIS SHAPE. `docs/KEPT-BEHAVIOURS.md` carries
the rule that neither party removes something on the other party's kept list.
A rule nobody can check is a habit, and two incidents in one week came through
exactly that gap: adoom666's row menu removed restart on a live row, the manual
mark-unread control and group filing, and ccsliinc's own merge nearly deleted
the owner's double-click rename because an incoming commit intended to.

Three mechanisms were weighed and two of them miss BOTH incidents:

  * CODEOWNERS asks for a review. `docs/DECISIONS.md` records that
    CloudeCodeDev runs an unprotected main by choice, so the request is
    advisory, and it cannot fire at all on work authored in the other
    developer's clone. Incident 1 arrived that way.
  * A line in the issue template only fires when the change was filed as an
    issue first. Issue #15 measured that in BOTH incidents no open issue named
    the files involved. Incident 2 was a merge, which is never an issue.

Only a check against the resulting TREE catches a merge and catches a commit
that arrived from somewhere else. So this runs on the tree, as pytest, in the
same family as `tests/test_no_remote_assets.py` - that test fails when a
forbidden string APPEARS, this one fails when a required string DISAPPEARS.

WHAT IT ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. It asserts that a
DECLARED claim still holds. An anchor is a short literal that the behaviour
rests on, named beside the behaviour by the party that relies on it, and the
guard fires when that literal is gone from every one of the behaviour's
declared paths that exists. It does NOT assert that a path exists (see
ALL_PATHS_MISSING below), does not assert coverage, and does not fail on an
entry that declares nothing - a checker that finds something on a clean tree
is a checker people switch off in week two, which would take the policy with
it.

SYMMETRY IS THE POINT. Every file in `docs/kept-behaviours/` is read, so
adoom666's file is guarded the day he adds it with no change here. His first
commit must not fail on a field he never agreed to, so an entry with no
`anchors:` or no `tests:` is REPORTED as incomplete, never failed. `--strict`
turns those reports into failures, and ccsliinc's own file is held to it, so
we take the higher bar without imposing it on anyone else.

THE FILE FORMAT, which `docs/KEPT-BEHAVIOURS.md` documents for humans:

    ### the behaviour, in a short phrase
    paths: client/js/one.js src/core/two.py
    anchors: someLiteral | another-literal
    tests: tests/test_one.node.mjs
    <prose>

`paths` is space separated. `anchors` is PIPE separated, because an anchor may
contain spaces (`frame-ancestors 'none'` is one). `tests` is space separated,
or the single word `none`, which is the honest way to record a behaviour that
nothing holds - see the double-click rename entry, which is the behaviour that
nearly died and the one with no test on its gesture.

Exit codes, matching `scripts/scan_secrets.py`: 0 clean, 1 findings, 2 could
not scan. 2 IS NOT A PASS.

Example:
    ./venv/bin/python3 scripts/check_kept_behaviours.py
    ./venv/bin/python3 scripts/check_kept_behaviours.py --strict docs/kept-behaviours/ccsliinc.md
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

#: Repo root, derived from this file so the checker works from any cwd.
REPO_ROOT = Path(__file__).resolve().parent.parent

#: The one directory holding per-party kept-behaviour files. One file per
#: party, named for its writer; that filename partition is what makes a
#: cross-party merge conflict structurally impossible.
KEPT_DIR = REPO_ROOT / "docs" / "kept-behaviours"

#: Field separators. Anchors use `|` because an anchor may contain spaces.
_ANCHOR_SEP = "|"

#: The literal a party writes when a behaviour has no test holding it. Spelled
#: out rather than left blank, because a blank field cannot be told apart from
#: someone forgetting to fill it in.
NO_TESTS = "none"


class KeptBehavioursError(Exception):
    """Raised when the check cannot be performed at all (exit 2, not a pass)."""


@dataclass
class Entry:
    """One kept behaviour, as declared in a party's file.

    Attributes:
        party: the file stem, e.g. `ccsliinc`.
        title: the `### ` heading text.
        line: 1-based line number of the heading, for the finding message.
        paths: repo-relative paths the behaviour lives in.
        anchors: literals that must survive, or None when undeclared.
        tests: test paths, [] when the party declared the literal `none`,
            or None when the field is undeclared.
    """

    party: str
    title: str
    line: int
    paths: List[str] = field(default_factory=list)
    anchors: Optional[List[str]] = None
    tests: Optional[List[str]] = None


@dataclass
class Finding:
    """One thing the guard has to say.

    Attributes:
        kind: a stable machine token, e.g. `MISSING_ANCHOR`.
        party: whose file the entry came from.
        title: the behaviour's heading.
        detail: a human sentence naming what is wrong.
        fatal: True when this alone should fail the build.
    """

    kind: str
    party: str
    title: str
    detail: str
    fatal: bool

    def render(self) -> str:
        """One line for a terminal.

        Returns:
            str: `FATAL KIND [party] title: detail`.
        """
        mark = "FATAL" if self.fatal else "note "
        return f"{mark} {self.kind} [{self.party}] {self.title}: {self.detail}"


def _split_paths(value: str) -> List[str]:
    """Split a space-separated path field.

    Args:
        value: the raw text after `paths:` or `tests:`.

    Returns:
        list[str]: non-empty tokens, order preserved.
    """
    return [tok for tok in value.split() if tok]


def _split_anchors(value: str) -> List[str]:
    """Split a pipe-separated anchor field, trimming each anchor.

    Args:
        value: the raw text after `anchors:`.

    Returns:
        list[str]: non-empty anchors, order preserved.

    Example:
        _split_anchors("frame-ancestors 'none' | default-src 'self'")
        -> ["frame-ancestors 'none'", "default-src 'self'"]
    """
    return [tok.strip() for tok in value.split(_ANCHOR_SEP) if tok.strip()]


def parse_party_file(path: Path) -> List[Entry]:
    """Parse one party's kept-behaviours file into entries.

    Only `### ` headings under a `## kept` section are entries. A `## disliked`
    section is preference, not a claim, and is deliberately not guarded: a
    preference has nothing in the tree to point at.

    Args:
        path: the party file, e.g. docs/kept-behaviours/ccsliinc.md.

    Returns:
        list[Entry]: one per kept behaviour, in file order.

    Raises:
        KeptBehavioursError: the file cannot be read.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise KeptBehavioursError(f"cannot read {path}: {exc}") from exc

    party = path.stem
    entries: List[Entry] = []
    in_kept = False
    current: Optional[Entry] = None

    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if line.startswith("## "):
            in_kept = line[3:].strip().lower() == "kept"
            current = None
            continue
        if not in_kept:
            continue
        if line.startswith("### "):
            current = Entry(party=party, title=line[4:].strip(), line=lineno)
            entries.append(current)
            continue
        if current is None:
            continue
        lowered = line.lower()
        if lowered.startswith("paths:"):
            current.paths = _split_paths(line[len("paths:"):])
        elif lowered.startswith("anchors:"):
            current.anchors = _split_anchors(line[len("anchors:"):])
        elif lowered.startswith("tests:"):
            tokens = _split_paths(line[len("tests:"):])
            if len(tokens) == 1 and tokens[0].lower() == NO_TESTS:
                current.tests = []
            else:
                current.tests = tokens

    return entries


def _read(root: Path, rel: str, cache: Dict[str, Optional[str]]) -> Optional[str]:
    """Read a repo-relative file once, memoised.

    Args:
        root: repo root to resolve against.
        rel: repo-relative path.
        cache: memo shared across one run.

    Returns:
        str | None: the text, or None when the file is absent or unreadable
        as text (a binary asset is not somewhere an anchor can live).
    """
    if rel in cache:
        return cache[rel]
    target = root / rel
    value: Optional[str] = None
    if target.is_file():
        try:
            value = target.read_text(encoding="utf-8", errors="replace")
        except OSError:
            value = None
    cache[rel] = value
    return value


def check_entry(entry: Entry, root: Path, cache: Dict[str, Optional[str]]) -> List[Finding]:
    """Check one behaviour against the tree.

    The three fatal outcomes, and why each is fatal:

      * ALL_PATHS_MISSING - every declared path is gone, so there is nowhere
        left for the behaviour to be. Note this is ALL, never per-path: some
        declared paths legitimately live on another branch (the `web/` Svelte
        paths are absent from this one, measured), and firing per-path would
        make the guard noisy on a clean tree, which is the trap.
      * MISSING_ANCHOR - a literal the party declared the behaviour rests on
        is absent from every declared path that exists. This is the removal.
      * MISSING_TEST_FILE - a named test is gone. A stale test reference is a
        false sense of coverage, which is worse than admitting none.

    Args:
        entry: the parsed behaviour.
        root: repo root.
        cache: file-read memo.

    Returns:
        list[Finding]: fatal and non-fatal, in that order of importance.
    """
    out: List[Finding] = []

    if not entry.paths:
        out.append(Finding("NO_PATHS", entry.party, entry.title,
                           "no `paths:` field, so nothing can be checked", False))
        return out

    present = [p for p in entry.paths if _read(root, p, cache) is not None]
    if not present:
        out.append(Finding(
            "ALL_PATHS_MISSING", entry.party, entry.title,
            "every declared path is absent: " + " ".join(entry.paths), True))
        return out

    if entry.anchors is None:
        out.append(Finding("UNGUARDED", entry.party, entry.title,
                           "no `anchors:` field, so a removal here is invisible", False))
    else:
        for anchor in entry.anchors:
            hit = any(anchor in (_read(root, p, cache) or "") for p in present)
            if not hit:
                out.append(Finding(
                    "MISSING_ANCHOR", entry.party, entry.title,
                    f"anchor {anchor!r} is gone from " + " ".join(present), True))

    if entry.tests is None:
        out.append(Finding("NO_TESTS_FIELD", entry.party, entry.title,
                           "no `tests:` field; write `tests: none` if nothing holds it", False))
    elif not entry.tests:
        out.append(Finding("NO_TEST", entry.party, entry.title,
                           "declares no test - the behaviour rests on the anchor alone", False))
    else:
        for rel in entry.tests:
            if not (root / rel).is_file():
                out.append(Finding(
                    "MISSING_TEST_FILE", entry.party, entry.title,
                    f"named test {rel} does not exist", True))

    return out


def party_files(kept_dir: Path) -> List[Path]:
    """List the per-party files to check.

    Args:
        kept_dir: docs/kept-behaviours.

    Returns:
        list[Path]: `*.md` files, sorted, so output order is stable.

    Raises:
        KeptBehavioursError: the directory is missing. That is a
        could-not-scan (exit 2), never a clean pass: an empty result and a
        deleted directory must not look the same.
    """
    if not kept_dir.is_dir():
        raise KeptBehavioursError(f"no kept-behaviours directory at {kept_dir}")
    return sorted(kept_dir.glob("*.md"))


def run(root: Path = REPO_ROOT, kept_dir: Optional[Path] = None,
        only: Optional[Sequence[Path]] = None) -> Tuple[List[Finding], int]:
    """Check every party's kept behaviours against a tree.

    Args:
        root: repo root the declared paths resolve against.
        kept_dir: where the party files live; defaults to `root/docs/kept-behaviours`.
        only: check just these party files instead of the whole directory.

    Returns:
        tuple[list[Finding], int]: findings, and how many entries were checked.

    Raises:
        KeptBehavioursError: nothing could be scanned.

    Example:
        findings, n = run()
        fatal = [f for f in findings if f.fatal]
    """
    kept = kept_dir if kept_dir is not None else (root / "docs" / "kept-behaviours")
    files = list(only) if only else party_files(kept)
    cache: Dict[str, Optional[str]] = {}
    findings: List[Finding] = []
    counted = 0
    for f in files:
        for entry in parse_party_file(f):
            counted += 1
            findings.extend(check_entry(entry, root, cache))
    return findings, counted


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Operator entry point.

    Args:
        argv: command line, defaults to sys.argv[1:].

    Returns:
        int: 0 clean, 1 findings, 2 could not scan.
    """
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("files", nargs="*", type=Path,
                    help="party files to check; default is every file in docs/kept-behaviours")
    ap.add_argument("--strict", action="store_true",
                    help="treat incomplete declarations as failures too")
    ap.add_argument("--root", type=Path, default=REPO_ROOT,
                    help="repo root the declared paths resolve against")
    args = ap.parse_args(argv)

    try:
        findings, counted = run(root=args.root, only=args.files or None)
    except KeptBehavioursError as exc:
        print(f"could not scan: {exc}", file=sys.stderr)
        return 2

    fatal = [f for f in findings if f.fatal]
    notes = [f for f in findings if not f.fatal]
    for f in fatal + notes:
        print(f.render())

    gaps = sum(1 for f in notes if f.kind == "NO_TEST")
    print(f"checked {counted} kept behaviours across "
          f"{len(args.files) if args.files else len(party_files(KEPT_DIR))} "
          f"part{'y' if (len(args.files) or 1) == 1 else 'ies'}: "
          f"{len(fatal)} fatal, {len(notes)} note(s), {gaps} with no test")

    if fatal:
        return 1
    # `--strict` is about whether the DECLARATION is complete, never about
    # coverage. NO_TEST is exempt on purpose: making an honest "nothing holds
    # this" fail the build pushes a party to name a test that does not really
    # cover the behaviour, or to drop the entry, and both are worse than the
    # gap stated plainly. The gap is reported on every run instead.
    if args.strict and any(f.kind != "NO_TEST" for f in notes):
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover - operator entry point
    sys.exit(main())
