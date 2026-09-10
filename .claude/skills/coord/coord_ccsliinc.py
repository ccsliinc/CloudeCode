"""The ccsliinc additions to adoom666's coord skill.

adoom666 wrote `coord.py` and `SKILL.md`. This module is the only file in the
skill directory ccsliinc authored outright, and it exists so that his file
stays as close to verbatim as possible: when his copy moves, re-forking is a
matter of taking his new file and re-applying a handful of marked call sites,
rather than untangling two authors from one 900 line source.

WHAT IS IN HERE, and why each piece came across from the retired
`scripts/coord.sh` when we adopted his tool on 2026-09-10:

1. `wants_kept` / `report_wants_overlap`. A claim says "I am EDITING these
   files". A kept behaviour says "I rely on something IN them surviving".
   Those are different questions with different answers and his protocol had
   no way to ask the second, while `wants/ccsliinc.md` was already sitting on
   the branch unread by any tool.
2. `FORBIDDEN_REMOTES`. `remote_with_branch` returns the FIRST remote whose
   `ls-remote` finds the branch. The ccsliinc clone carries `upstream` pointing
   at a real, fetchable GitHub repo whose PUSH url is a deliberate broken
   sentinel under a standing owner instruction. A probe cannot tell a shared
   remote from a poisoned one, and alphabetical order is not a guard.
3. `secret_scan`. The pre-commit hook resolves `scripts/scan_secrets.py`
   relative to the worktree, and `coord` is an orphan branch carrying no
   `scripts/` directory, so the hook cannot run there at all. Without this a
   claim is the one file in this repo that reaches a remote unscanned, and a
   claim is prose, which is where a pasted token lives.
4. `lock_acquire` / `lock_release`. The coord checkout lives in the COMMON git
   dir, so every linked worktree of a clone shares one. ccsliinc runs seven.
5. `common_dir`. In a LINKED worktree `.git` is a FILE, so `root / ".git" /
   "coord-worktree"` names a path that cannot hold a checkout. In a primary
   worktree the two resolve identically.

Nothing here changes a verdict his code already reaches. The wants check is a
WARNING that never moves an exit code; the two refusals are refusals on
purpose.

`expand` is passed in rather than imported. This module must not import
`coord`, because `coord` is run as `__main__` and importing it by name would
build a second copy of it in the same process.
"""

from __future__ import annotations

import re
import subprocess
from collections.abc import Callable, Iterable
from pathlib import Path

FORBIDDEN_REMOTES = frozenset({"upstream"})


def lock_acquire(root: Path) -> Path | None:
    """Take an exclusive lock on the shared coord worktree.

    `mkdir` is atomic on POSIX, so this needs no dependency. The coord worktree
    lives in the COMMON git dir and is therefore shared by every linked
    worktree of the clone, which is what makes two concurrent agents a real
    race rather than a theoretical one.

    Args:
        root: repository root.

    Returns:
        The lock directory to release, or None when it is already held.

    Example:
        >>> lock = lock_acquire(Path("/repo"))  # doctest: +SKIP
        >>> lock_release(lock)                  # doctest: +SKIP
    """
    lock = common_dir(root) / "coord-worktree.lock"
    try:
        lock.mkdir()
    except FileExistsError:
        return None
    return lock


def lock_release(lock: Path | None) -> None:
    """Release a lock taken by `lock_acquire`.

    Args:
        lock: the directory returned by `lock_acquire`, or None.

    Returns:
        None.
    """
    if lock is not None:
        try:
            lock.rmdir()
        except OSError:
            # Nothing to do about a lock we cannot remove except say so. A
            # raise here would mask whatever the caller was actually reporting.
            print(f"warning: could not release {lock}; remove it by hand")


def common_dir(root: Path) -> Path:
    """Return the shared `.git` directory for this clone.

    Every linked worktree resolves to the SAME directory, which is what lets
    one coord checkout serve all of them.

    Args:
        root: repository root.

    Returns:
        Absolute path to the common git dir.
    """
    out = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--git-common-dir"],
        capture_output=True, text=True, check=True,
    )
    found = Path(out.stdout.strip())
    return found if found.is_absolute() else (root / found).resolve()


def wants_kept(text: str) -> list[tuple[str, str]]:
    """Parse the KEPT behaviours out of a party's wants file.

    A kept behaviour is a `### <label>` heading optionally followed by a
    `paths: <globs>` line, and ONLY the `## kept` section is read. The
    `## disliked` section deliberately carries no paths: a dislike is a
    preference, and a preference must never be able to warn anyone off a file.

    Args:
        text: full contents of a wants file.

    Returns:
        (label, globs) for each kept behaviour that declares paths.

    Example:
        >>> wants_kept("## kept\\n### a thing\\npaths: src/*.py\\n")
        [('a thing', 'src/*.py')]
    """
    section = re.search(r"^##\s*kept\s*$(.*?)(^##\s|\Z)", text, re.S | re.M)
    if not section:
        return []
    kept: list[tuple[str, str]] = []
    label = ""
    for line in section.group(1).splitlines():
        if line.startswith("### "):
            label = line[4:].strip()
        elif line.startswith("paths:") and label:
            kept.append((label, line.partition(":")[2].strip()))
            label = ""
    return kept


def load_wants(
    remote: str,
    branch_files: Callable[[str], Iterable[str]],
    show: Callable[[str, str], str | None],
) -> list[tuple[str, list[tuple[str, str]]]]:
    """Read every party's kept behaviours off the branch.

    Args:
        remote: remote carrying the branch.
        branch_files: `coord.branch_files`, injected so this module never
            imports `coord`. See the note at the bottom of the module docstring.
        show: `coord.show`, injected for the same reason.

    Returns:
        (party, [(label, globs), ...]) for each wants file present.

    Example:
        >>> load_wants("adamdev", lambda r: [], lambda r, p: None)
        []
    """
    out = []
    for path in branch_files(remote):
        if not path.startswith("wants/") or not path.endswith(".md"):
            continue
        text = show(remote, path)
        if text:
            out.append((Path(path).stem, wants_kept(text)))
    return out


def report_wants_overlap(
    wants: list[tuple[str, list[tuple[str, str]]]],
    actor: str | None,
    mine: set[str],
    files: list[str],
    expand: Callable[[str, list[str]], set[str]],
    lead: str,
) -> bool:
    """Warn when a path set touches another party's kept behaviours.

    This is a WARNING and never a refusal, and that is the whole design. Editing
    a file is not removing a behaviour, and a check that cried wolf on every
    edit would be switched off inside a week. What it buys is catching a removal
    BEFORE the work rather than in a merge review afterwards.

    Args:
        wants: the result of `load_wants`.
        actor: the party whose paths these are; its own wants are skipped,
            because warning a party off its own kept list says nothing.
        mine: already-expanded paths under consideration.
        files: this repo's tracked file list, to expand the wants globs against.
        expand: `coord.expand`, injected. One glob expander for the whole tool,
            or a claim and a kept list would disagree about what a path means.
        lead: sentence printed before the first hit.

    Returns:
        True when at least one kept behaviour was touched.
    """
    hit = False
    for owner, kept in wants:
        if actor and owner == actor:
            continue
        for label, globs in kept:
            shared = sorted(mine & expand(globs, files))
            if not shared:
                continue
            if not hit:
                print(lead)
                hit = True
            print(f"WARNING  touches {owner} wants kept: {label}")
            for path in shared:
                print(f"  {path}")
            print("  you may ADD alongside it. you may NOT remove it alone.")
            print("  if yours and theirs cannot coexist, that is an overlap:")
            print("  stop and surface it, exactly as you would a path overlap.")
    return hit


def secret_scan(root: Path, tree: Path) -> tuple[bool, str]:
    """Run this repo's own secret scanner over the staged coord content.

    The pre-commit hook cannot help here: it resolves `scripts/scan_secrets.py`
    relative to the worktree, and the coord branch is an orphan carrying no
    scripts/ directory at all. So the scanner is invoked from the MAIN tree
    against the coord checkout. Exit 2 from that scanner means COULD NOT SCAN,
    and 2 is not 0, so anything but a clean pass refuses.

    Args:
        root: repository root, where scripts/ and venv/ live.
        tree: the coord worktree holding the staged files.

    Returns:
        (allowed, reason). `allowed` is False on a finding AND on a scanner
        that could not run, because not having looked is not a pass.
    """
    scanner = root / "scripts" / "scan_secrets.py"
    if not scanner.is_file():
        return False, f"cannot find {scanner}, so nothing was scanned"
    venv = root / "venv" / "bin" / "python3"
    python = str(venv) if venv.is_file() else "python3"
    run = subprocess.run(
        [python, str(scanner), "--staged", "--repo", str(tree)],
        capture_output=True, text=True,
    )
    if run.returncode == 0:
        return True, "clean"
    return False, (run.stdout + run.stderr).strip() or f"exit {run.returncode}"
