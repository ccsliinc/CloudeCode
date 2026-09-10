#!/usr/bin/env python3
"""Cross-party coordination on the orphan `coord` branch.

Two teams ship into one codebase with agents that produce a lot of change in
a few hours. The `coord` branch is where each side says what it is about to
do BEFORE doing it, so the other side finds out from a paragraph instead of
from a fetch three days later.

This tool does the three things an agent gets wrong by hand: expanding claim
globs against the real file list and intersecting them, writing to an orphan
branch without disturbing the working tree, and refusing to write a file that
carries another party's name.

Everything else is prose. Read SKILL.md.

Commands:
    read                     fetch and print the other parties' live state
    check PATH [PATH ...]    report overlaps against every active claim
    write KIND SLUG          write a file from stdin (kind: now/claim/log/note/settled)
    sync                     commit and push whatever `write` staged

Exit codes:
    0  no overlap / success
    2  overlap found (check)
    3  cannot determine (no branch, no party, unreadable)
    4  refused (tried to write another party's file)
"""
from __future__ import annotations

import fnmatch
import os
import re
import subprocess
import sys
from pathlib import Path

BRANCH = "coord"
KINDS = {"now", "claim", "log", "note", "settled"}
#: A claim stops counting as an overlap this many days after `refreshed`.
#: Matches the 72 hours the protocol's README specifies.
EXPIRY_DAYS = 3


def repo_root() -> Path:
    """Return the repository root.

    Returns:
        Absolute path to the top of the working tree.
    """
    out = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=True,
    )
    return Path(out.stdout.strip())


def remote_with_branch() -> str | None:
    """Return the remote that carries the coord branch.

    The other party names this repo differently in their own clone, so the
    remote is discovered rather than assumed.

    Returns:
        Remote name, or None when no remote has the branch.
    """
    out = subprocess.run(
        ["git", "remote"], capture_output=True, text=True, check=True,
    )
    for remote in out.stdout.split():
        probe = subprocess.run(
            ["git", "ls-remote", "--exit-code", "--heads", remote, BRANCH],
            capture_output=True, text=True,
        )
        if probe.returncode == 0:
            return remote
    return None


def party(root: Path) -> str | None:
    """Return this clone's party name.

    Stored in `.git/coord-party` so it is per-clone and never committed. Two
    clones of the same repo are different parties; a tracked config file
    could not express that.

    Args:
        root: repository root.

    Returns:
        The party name, or None when it has not been set.
    """
    env = os.environ.get("COORD_PARTY", "").strip()
    if env:
        return env
    marker = root / ".git" / "coord-party"
    if marker.is_file():
        value = marker.read_text(encoding="utf-8").strip()
        if value:
            return value
    return None


def show(remote: str, path: str) -> str | None:
    """Read one file from the coord branch without checking it out.

    Args:
        remote: remote carrying the branch.
        path: path within the branch.

    Returns:
        File contents, or None when the path does not exist there.
    """
    out = subprocess.run(
        ["git", "show", f"{remote}/{BRANCH}:{path}"],
        capture_output=True, text=True,
    )
    return out.stdout if out.returncode == 0 else None


def branch_files(remote: str) -> list[str]:
    """List every file on the coord branch.

    Args:
        remote: remote carrying the branch.

    Returns:
        Branch-relative paths, sorted.
    """
    out = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", f"{remote}/{BRANCH}"],
        capture_output=True, text=True,
    )
    return sorted(out.stdout.split()) if out.returncode == 0 else []


def header(text: str) -> dict[str, str]:
    """Parse a claim's leading `---` fenced key/value block.

    Args:
        text: full file contents.

    Returns:
        Mapping of key to value. Empty when there is no header.
    """
    match = re.match(r"\s*---\s*\n(.*?)\n---\s*\n", text, re.S)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip()
    return fields


def expired(fields: dict[str, str]) -> bool:
    """Report whether a claim has aged out.

    Expiry is computed at read time rather than by deleting files, because a
    job that deleted files on this branch would be a second unsupervised
    writer and it would race.

    Args:
        fields: parsed claim header.

    Returns:
        True when the claim is stale or its dates are unreadable.
    """
    from datetime import date, timedelta

    stamp = fields.get("refreshed") or fields.get("opened") or ""
    try:
        year, month, day = (int(part) for part in stamp.split("-"))
    except ValueError:
        return True
    return date(year, month, day) + timedelta(days=EXPIRY_DAYS) < date.today()


def tracked_files() -> list[str]:
    """List every tracked file in this repository.

    Globs are expanded against the reader's own file list. The two parties'
    trees differ, so a claim naming a path this repo does not have simply
    matches nothing here rather than erroring.

    Returns:
        Repo-relative paths.
    """
    out = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, check=True,
    )
    return out.stdout.splitlines()


def expand(globs: str, files: list[str]) -> set[str]:
    """Expand a claim's space separated globs against a file list.

    `*` matches across `/` here, so `src/core/session_*.py` works as written.
    Expansion beats string comparison: one side's `src/core/*_manager.py` and
    the other's literal `src/core/session_manager.py` look nothing alike and
    are the same file.

    Args:
        globs: space separated patterns.
        files: candidate paths.

    Returns:
        Matching paths.

    Example:
        >>> expand("src/*.py", ["src/a.py", "docs/b.md"])
        {'src/a.py'}
    """
    hits: set[str] = set()
    for pattern in globs.split():
        hits.update(fnmatch.filter(files, pattern))
        if pattern in files:
            hits.add(pattern)
    return hits


def load_claims(remote: str) -> list[tuple[str, dict[str, str], str]]:
    """Read every claim on the branch.

    Args:
        remote: remote carrying the branch.

    Returns:
        Tuples of (path, header fields, body).
    """
    claims = []
    for path in branch_files(remote):
        if not path.startswith("claims/"):
            continue
        text = show(remote, path)
        if text:
            claims.append((path, header(text), text))
    return claims


def cmd_read(remote: str, me: str | None) -> int:
    """Print the other parties' live state.

    Args:
        remote: remote carrying the branch.
        me: this clone's party name, or None.

    Returns:
        Process exit code.
    """
    subprocess.run(["git", "fetch", "--quiet", remote, BRANCH], check=False)
    files = branch_files(remote)
    if not files:
        print(f"no {BRANCH} branch on {remote}")
        return 3

    for path in files:
        if path.startswith("now/") and (me is None or f"/{me}." not in path):
            print(f"=== {path}")
            print((show(remote, path) or "").strip(), "\n")

    for path, fields, text in load_claims(remote):
        if me and f"/{me}-" in path:
            continue
        state = fields.get("status", "?")
        if expired(fields):
            state = "EXPIRED_OR_DONE"
        print(f"=== {path}  [{state}]  {fields.get('title', '')}")
        approach = re.search(r"##\s*approach\s*\n(.*?)(\n##|\Z)", text, re.S)
        if approach:
            print(approach.group(1).strip()[:900], "\n")

    for path in files:
        if path.startswith("settled/") and (me is None or f"/{me}." not in path):
            print(f"=== {path}")
            print((show(remote, path) or "").strip()[:1500], "\n")
    return 0


def cmd_check(remote: str, me: str | None, paths: list[str]) -> int:
    """Report overlaps between the given paths and every live claim.

    Args:
        remote: remote carrying the branch.
        me: this clone's party name, or None.
        paths: paths or globs this session intends to touch.

    Returns:
        0 when clear, 2 when any live claim overlaps.
    """
    subprocess.run(["git", "fetch", "--quiet", remote, BRANCH], check=False)
    files = tracked_files()
    mine = expand(" ".join(paths), files) or set(paths)
    found = False

    for path, fields, text in load_claims(remote):
        if me and f"/{me}-" in path:
            continue
        if expired(fields) or fields.get("status") == "done":
            continue
        theirs = expand(fields.get("paths", ""), files)
        shared = sorted(mine & theirs)
        if shared:
            found = True
            print(f"OVERLAP with {path} ({fields.get('party', '?')}, "
                  f"{fields.get('status', '?')}, branch {fields.get('branch', '?')})")
            for hit in shared:
                print(f"  {hit}")
            print()

    if not found:
        print("no path overlap with any live claim")
        print("PATHS ARE THE CHEAP HALF. Read their approach paragraphs for a")
        print("design overlap: a contradiction counts even with no shared file.")
    return 2 if found else 0


def cmd_write(remote: str, me: str, kind: str, slug: str) -> int:
    """Write one file to the coord branch from stdin.

    Refuses any path not carrying this party's name. The naming fence is what
    makes a cross-party merge conflict structurally impossible, so it is
    enforced here rather than left to care.

    Args:
        remote: remote carrying the branch.
        me: this clone's party name.
        kind: one of KINDS.
        slug: short name for claim/note files; ignored for now/log/settled.

    Returns:
        0 on success, 4 when the write was refused.
    """
    if kind not in KINDS:
        print(f"kind must be one of {sorted(KINDS)}")
        return 4
    if kind in {"now", "log", "settled"}:
        rel = f"{kind}/{me}.md"
    else:
        rel = f"{kind}s/{me}-{slug}.md"
    if me not in rel:
        print(f"refused: {rel} does not carry your party name")
        return 4

    body = sys.stdin.read()
    if not body.strip():
        print("refused: empty body")
        return 4

    root = repo_root()
    tree = root / ".git" / "coord-worktree"
    # Only sync to the remote tip when creating the worktree. Resetting on
    # every write would discard whatever an earlier write staged, so a
    # session that writes `now` and then `log` would push only the second.
    if not tree.exists():
        subprocess.run(["git", "fetch", "--quiet", remote, BRANCH], check=False)
        subprocess.run(
            ["git", "worktree", "add", "--quiet", "--detach", str(tree),
             f"{remote}/{BRANCH}"], check=True,
        )

    target = tree / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8")
    subprocess.run(["git", "-C", str(tree), "add", rel], check=True)
    print(f"staged {rel} in {tree}")
    return 0


def cmd_sync(remote: str, me: str) -> int:
    """Commit and push whatever `write` staged.

    A rejected push means the other party pushed first. Their protocol calls
    the push itself the lock: re-read before retrying, because what you were
    about to claim may now be claimed.

    Args:
        remote: remote carrying the branch.
        me: this clone's party name.

    Returns:
        Process exit code.
    """
    root = repo_root()
    tree = root / ".git" / "coord-worktree"
    if not tree.exists():
        print("nothing staged")
        return 3
    staged = subprocess.run(
        ["git", "-C", str(tree), "diff", "--cached", "--name-only"],
        capture_output=True, text=True,
    ).stdout.split()
    if not staged:
        print("nothing staged")
        return 3
    for path in staged:
        if me not in path:
            print(f"refused: {path} is not yours")
            return 4
    subprocess.run(
        ["git", "-C", str(tree), "commit", "--quiet", "-m",
         f"coord: {me} update ({', '.join(staged)})"], check=True,
    )
    push = subprocess.run(
        ["git", "-C", str(tree), "push", remote, f"HEAD:{BRANCH}"],
        capture_output=True, text=True,
    )
    sys.stdout.write(push.stdout + push.stderr)
    if push.returncode != 0:
        print("\npush rejected: someone else wrote first. re-read before retrying.")
        return 3
    print(f"pushed {', '.join(staged)}")
    return 0


def main(argv: list[str]) -> int:
    """Entry point.

    Args:
        argv: command line arguments without the program name.

    Returns:
        Process exit code.
    """
    if not argv:
        print(__doc__)
        return 3
    root = repo_root()
    me = party(root)
    remote = remote_with_branch()
    if remote is None:
        print(f"no remote carries a {BRANCH} branch")
        return 3

    command = argv[0]
    if command == "read":
        return cmd_read(remote, me)
    if command == "check":
        if len(argv) < 2:
            print("check needs at least one path")
            return 3
        return cmd_check(remote, me, argv[1:])
    if me is None:
        print("set your party name first:")
        print("  echo adoom666 > .git/coord-party")
        return 3
    if command == "write":
        if len(argv) < 2:
            print("write needs a kind")
            return 3
        return cmd_write(remote, me, argv[1], argv[2] if len(argv) > 2 else "")
    if command == "sync":
        return cmd_sync(remote, me)
    print(__doc__)
    return 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
