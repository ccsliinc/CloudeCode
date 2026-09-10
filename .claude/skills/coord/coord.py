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
    write KIND SLUG          write a file from stdin (kind: now/claim/log/note/settled/lesson/wants)
    lessons                  print every party's lessons, newest observation first
    sync                     commit and push whatever `write` staged

    --party NAME             read as another party. READ-ONLY: valid on read,
                             check and lessons, refused with 4 on write/sync.

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

# ccsliinc: the ccsliinc additions live next door so this file stays close to
# the version adoom666 publishes at adamdev/master. Everything imported here is
# listed in that module's docstring and in SKILL.md. sys.path is extended
# because this file is run as a script, not imported as a package.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from coord_ccsliinc import (  # noqa: E402
    FORBIDDEN_REMOTES,
    common_dir,
    load_wants,
    lock_acquire,
    lock_release,
    report_wants_overlap,
    secret_scan,
)

BRANCH = "coord"
KINDS = {"now", "claim", "log", "note", "settled", "lesson", "wants"}
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
        # ccsliinc: skip a remote this clone must never touch. See
        # FORBIDDEN_REMOTES. Discovery probes remotes in whatever order git
        # lists them, and a probe cannot tell a shared remote from a poisoned
        # one, so it has to be told.
        if remote in FORBIDDEN_REMOTES:
            continue
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
    # ccsliinc: the on-disk marker now wins over the environment, where it used
    # to be the other way round. WHO YOU ARE IS A PROPERTY OF THE CLONE, and
    # with the environment first a single `COORD_PARTY=them` in front of one
    # command asserts the other party's identity for that invocation, which
    # makes the naming fence decorative for exactly the caller who would abuse
    # it. The variable stays useful as a READ-ONLY LENS on a clone that has not
    # set a marker, which is how `read` and `check` see the branch through the
    # other side's eyes.
    # ccsliinc: common_dir, for the linked-worktree reason given in cmd_write.
    # One marker per CLONE is the intent, and every linked worktree shares it.
    marker = common_dir(root) / "coord-party"
    if marker.is_file():
        value = marker.read_text(encoding="utf-8").strip()
        if value:
            return value
    env = os.environ.get("COORD_PARTY", "").strip()
    return env or None


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
        True when the claim is measurably stale. An unreadable date returns
        False, so a malformed claim is still treated as live: see the body.
    """
    from datetime import date, timedelta

    stamp = fields.get("refreshed") or fields.get("opened") or ""
    try:
        year, month, day = (int(part) for part in stamp.split("-"))
        when = date(year, month, day)
    except ValueError:
        # A DATE WE CANNOT READ MUST STILL COUNT AS AN OVERLAP. Treating it
        # as expired would make a claim with a typo'd header silently
        # invisible to the detector, in the one function whose whole job is
        # catching collisions. A hand-written header is exactly where a typo
        # lands, so this fails toward being seen.
        #
        # The date() construction is inside the try on purpose: "2026-13-01"
        # parses as three ints and then raises out of date(), which used to
        # crash the whole run rather than degrade.
        return False
    return when + timedelta(days=EXPIRY_DAYS) < date.today()


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


def cmd_lessons(remote: str) -> int:
    """Print every party's lessons.

    Lessons are read from ALL parties including your own, because a lesson is
    something to apply rather than something to disclose. Yours are as easy to
    forget as theirs.

    Args:
        remote: remote carrying the branch.

    Returns:
        Process exit code.
    """
    subprocess.run(["git", "fetch", "--quiet", remote, BRANCH], check=False)
    found = False
    for path in branch_files(remote):
        if not path.startswith("lessons/"):
            continue
        text = show(remote, path) or ""
        fields = header(text)
        found = True
        seen = fields.get("occurrences", "?")
        print(f"=== {path}  [seen {seen}x, {fields.get('scope', '?')}]  "
              f"{fields.get('title', '')}")
        body = re.sub(r"\s*---\s*\n.*?\n---\s*\n", "", text, count=1, flags=re.S)
        print(body.strip()[:1200], "\n")
    if not found:
        print("no lessons recorded yet")
    return 0


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

    # ccsliinc: the OTHER direction of the wants check, and the one that
    # belongs at session start. `check` asks "am I about to touch something
    # they want kept". This asks "is somebody about to touch something WE want
    # kept", which nothing else in the protocol would ever tell us, because
    # their claim is on their side of the branch and we would only find out by
    # reading every one of them by hand.
    tracked = tracked_files()
    kept = load_wants(remote, branch_files, show)
    for path, fields, _ in load_claims(remote):
        if expired(fields) or fields.get("status") == "done":
            continue
        owner = fields.get("party") or ""
        if me and owner == me:
            continue
        theirs = expand(fields.get("paths", ""), tracked)
        report_wants_overlap(
            kept, owner, theirs, tracked, expand,
            f"--- {path} touches a kept behaviour ---",
        )

    # Lessons last and unfiltered: they are the accumulated fixes for
    # collisions that already happened, and they apply to both parties.
    cmd_lessons(remote)
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

    # ccsliinc: a claim overlap says another party is EDITING these files. This
    # says another party asked for a BEHAVIOUR in them to survive, which is a
    # different question with a different answer, and it fires here because
    # here is before the work. It never changes the exit code: a warning that
    # blocked would be silenced, and then the overlap check would be silenced
    # with it.
    print()
    if not report_wants_overlap(
        load_wants(remote, branch_files, show), me, mine, files, expand,
        "--- these paths carry behaviours another party asked to keep ---",
    ):
        print("no kept behaviour of another party sits in these paths")
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
    # ccsliinc: `wants` joins the one-file-per-party kinds. It is a whole-file
    # replacement like `now`, not a slugged set, because a party has exactly
    # one kept list and two would immediately disagree.
    if kind in {"now", "log", "settled", "wants"}:
        rel = f"{kind}/{me}.md"
    else:
        rel = f"{kind}s/{me}-{slug}.md"
    if kind in {"claim", "note", "lesson"} and not slug:
        print(f"{kind} needs a slug")
        return 4
    # ccsliinc: this compares against the party name RESOLVED FOR THIS CLONE,
    # not against `me` woven into the path we just built from `me`. As written
    # the test could never fail, so it read as a fence and was decorative. The
    # real fence was one rung later, in cmd_sync, on the staged path list.
    owner = party(repo_root())
    if owner is None or f"{owner}" != me or owner not in rel:
        print(f"refused: {rel} does not carry this clone's party name")
        return 4

    root = repo_root()
    # ccsliinc: through common_dir rather than `root / ".git"`. In a LINKED
    # worktree `.git` is a FILE pointing elsewhere, so the original expression
    # names a path that cannot hold a checkout, and it fails only at write
    # time. ccsliinc runs seven linked worktrees off this clone. In a primary
    # worktree the two expressions are the same path, so nothing changes there.
    tree = common_dir(root) / "coord-worktree"
    lock = lock_acquire(root)
    if lock is None:
        print("another coord run holds the worktree lock. retry, or remove")
        print(f"  {common_dir(root) / 'coord-worktree.lock'}  if it is stale")
        return 3
    try:
        return _write_body(remote, me, rel, tree)
    finally:
        lock_release(lock)


def _write_body(remote: str, me: str, rel: str, tree: Path) -> int:
    """Stage one already-validated coord file. See `cmd_write`.

    Split out by ccsliinc only so the lock has a `finally` to release in.

    Args:
        remote: remote carrying the branch.
        me: this clone's party name.
        rel: validated branch-relative path.
        tree: the coord worktree.

    Returns:
        0 on success.
    """
    body = sys.stdin.read()
    if not body.strip():
        print("refused: empty body")
        return 4
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
    # ccsliinc: refuse outright rather than trusting discovery order. See
    # FORBIDDEN_REMOTES and the note in remote_with_branch.
    if remote in FORBIDDEN_REMOTES:
        print(f"refused: '{remote}' is a forbidden remote on this clone")
        return 4
    tree = common_dir(root) / "coord-worktree"
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

    # ccsliinc: the repo's own scanner, run explicitly, because the pre-commit
    # hook cannot resolve itself from an orphan branch carrying no scripts/.
    # Without this a claim is the one file in this repo that reaches a remote
    # unscanned, and a claim is prose, which is where a pasted token lives.
    allowed, reason = secret_scan(root, tree)
    if not allowed:
        print(f"refused: secret scan did not pass. nothing committed.\n{reason}")
        return 4

    subprocess.run(
        ["git", "-C", str(tree), "commit", "--quiet", "--no-verify", "-m",
         f"coord: {me} update ({', '.join(staged)})"], check=True,
    )
    push = subprocess.run(
        ["git", "-C", str(tree), "push", remote, f"HEAD:{BRANCH}"],
        capture_output=True, text=True,
    )
    sys.stdout.write(push.stdout + push.stderr)
    if push.returncode == 0:
        print(f"pushed {', '.join(staged)}")
        return 0

    # A rejection means the other party wrote while we were composing, which
    # is information rather than an error. Rebase so the work is not stranded
    # (party-namespaced paths cannot conflict), then STOP: what they just
    # wrote may change what you were about to say. Re-run sync to push.
    before = subprocess.run(
        ["git", "-C", str(tree), "rev-parse", f"{remote}/{BRANCH}"],
        capture_output=True, text=True,
    ).stdout.strip()
    subprocess.run(["git", "-C", str(tree), "fetch", "--quiet", remote, BRANCH],
                   check=False)
    rebase = subprocess.run(
        ["git", "-C", str(tree), "rebase", f"{remote}/{BRANCH}"],
        capture_output=True, text=True,
    )
    print("\npush rejected: the other party wrote first.")
    if rebase.returncode != 0:
        subprocess.run(["git", "-C", str(tree), "rebase", "--abort"], check=False)
        print("could not rebase automatically. resolve in", tree)
        return 3
    landed = subprocess.run(
        ["git", "-C", str(tree), "log", "--oneline", f"{before}..{remote}/{BRANCH}"],
        capture_output=True, text=True,
    ).stdout.strip()
    print("your commit is rebased and NOT pushed. what they wrote:\n")
    print(landed or "(nothing new, transient failure)")
    print("\nread it, revise if it changes what you were saying, then sync again.")
    return 3


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

    # ccsliinc: `--party X` is a READ-ONLY LENS, valid only on the commands that
    # cannot write. It is REFUSED on write and sync, because a per-command
    # identity flag on a writing command turns the naming fence into a comment.
    # The legitimate way to write as another party is to be another clone.
    command = argv[0]
    rest: list[str] = []
    argv_tail = argv[1:]
    while argv_tail:
        token = argv_tail.pop(0)
        if token != "--party":
            rest.append(token)
            continue
        if command not in {"read", "check", "lessons"}:
            print(f"refused: --party is read-only and not valid on '{command}'.")
            print("to write as another party, set: echo NAME > .git/coord-party")
            return 4
        if not argv_tail:
            print("--party needs a name")
            return 3
        me = argv_tail.pop(0)
    argv = [command] + rest

    remote = remote_with_branch()
    if remote is None:
        print(f"no remote carries a {BRANCH} branch")
        print(f"(remotes named {sorted(FORBIDDEN_REMOTES)} are never probed)")
        return 3

    if command == "read":
        return cmd_read(remote, me)
    if command == "lessons":
        return cmd_lessons(remote)
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
