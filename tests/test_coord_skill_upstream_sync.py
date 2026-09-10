"""Staleness guard: notice when adoom666's copy of the coord skill moves.

WHY THIS EXISTS. `.claude/skills/coord/` is not ours. adoom666 wrote it, we
evaluated it against our own `scripts/coord.sh` on 2026-09-10, found his the
better tool, adopted it and retired ours. Adopting somebody else's tool buys a
better tool and a new failure mode: his copy is the upstream of ours and will
change, and nothing about a vendored file announces that it has fallen behind.
A skill that silently drifts from the one the other party is running is worse
than two acknowledged tools, because both sides believe they are coordinating
through the same thing.

WHAT IT MEASURES, AND WHAT IT DOES NOT. It compares the blob shas recorded in
`.claude/skills/coord/UPSTREAM.md` against `adamdev/master`. So it detects HIS
copy MOVING, not our copy DIVERGING. That distinction is the whole design: our
copy is deliberately different (see the ccsliinc block in `coord.py`), so a
guard asserting byte-equality would have been red the moment it shipped, and a
guard that is red on day one is deleted in week one.

It reads the LOCAL remote-tracking ref, so it needs no network, and it can
therefore only prove we are current with the last fetch. The failure text says
that rather than implying more. When the ref is absent entirely, the test skips
with a reason naming what went unmeasured: NOT HAVING LOOKED IS NOT A PASS,
which is the same discipline the rest of this codebase applies to `unchecked`
versus a measured absence.

THE NEGATIVE CONTROL IS LOAD-BEARING. A comparison that reported "in sync" for
every input would pass the positive test perfectly and guard nothing, which is
this project's oldest recurring defect. `test_the_guard_actually_fires` feeds
the same function a sha that is deliberately wrong and requires it to report
drift.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SKILL_DIR = REPO / ".claude" / "skills" / "coord"
UPSTREAM_DOC = SKILL_DIR / "UPSTREAM.md"

#: Where adoom666 publishes the skill. `adamdev` is the shared remote; the
#: forbidden `upstream` remote is a different repo entirely and is never read.
UPSTREAM_REF = "adamdev/master"
UPSTREAM_PREFIX = ".claude/skills/coord"

#: The files whose upstream sha we track. Adding one here without adding it to
#: UPSTREAM.md fails the parse test below rather than being skipped quietly.
TRACKED = ("SKILL.md", "coord.py")

#: Files ccsliinc wrote, which have no upstream and so cannot drift from one.
#: They still have to be TRACKED BY GIT, which is a different failure and the
#: one `.gitignore` causes, so they are asserted separately.
OURS = ("coord_ccsliinc.py", "UPSTREAM.md")


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    """Run a git command in this repository.

    Args:
        *args: arguments after `git`.

    Returns:
        The completed process, never raising on a non-zero exit.
    """
    return subprocess.run(
        ["git", "-C", str(REPO), *args], capture_output=True, text=True,
    )


def recorded_shas() -> dict[str, str]:
    """Parse the fork-point blob shas out of UPSTREAM.md.

    Returns:
        Mapping of file name to the 40 character blob sha recorded for it.

    Example:
        >>> sorted(recorded_shas())  # doctest: +SKIP
        ['SKILL.md', 'coord.py']
    """
    text = UPSTREAM_DOC.read_text(encoding="utf-8")
    found: dict[str, str] = {}
    for name in TRACKED:
        match = re.search(
            rf"^{re.escape(name)}:\s*([0-9a-f]{{40}})\s*$", text, re.M,
        )
        if match:
            found[name] = match.group(1)
    return found


def upstream_sha(name: str) -> str | None:
    """Read the current blob sha of one skill file on the upstream ref.

    Args:
        name: file name inside the skill directory.

    Returns:
        The blob sha, or None when the ref or the path is not present locally.
    """
    out = _git("rev-parse", f"{UPSTREAM_REF}:{UPSTREAM_PREFIX}/{name}")
    if out.returncode != 0:
        return None
    sha = out.stdout.strip()
    return sha if re.fullmatch(r"[0-9a-f]{40}", sha) else None


def drifted(name: str, recorded: str) -> bool:
    """Report whether upstream's copy of one file has moved off the fork point.

    THE FUNCTION UNDER TEST. It is deliberately separate from the assertions so
    the negative control can feed it a known-wrong sha and require a True.

    Args:
        name: file name inside the skill directory.
        recorded: the blob sha UPSTREAM.md says we forked from.

    Returns:
        True when upstream's current sha differs from `recorded`. False when
        they agree. Raises when upstream cannot be read, because a comparison
        that could not run must never answer "in sync".

    Raises:
        LookupError: the upstream ref or path is not available locally.

    Example:
        >>> drifted("coord.py", "0" * 40)  # doctest: +SKIP
        True
    """
    current = upstream_sha(name)
    if current is None:
        raise LookupError(
            f"cannot read {UPSTREAM_REF}:{UPSTREAM_PREFIX}/{name} locally"
        )
    return current != recorded


def _upstream_available() -> bool:
    """Report whether the upstream ref exists in this clone.

    Returns:
        True when every tracked file can be resolved on the ref.
    """
    return all(upstream_sha(name) is not None for name in TRACKED)


def test_the_skill_is_installed_and_tracked() -> None:
    """The skill files exist and are tracked despite the .claude gitignore.

    `.gitignore` ignores `.claude/*`, so these files are only in git because
    they were force-added. An untracked skill is invisible to everyone who
    clones, which is exactly how every design note in this repo stayed out of
    git until 2026-09-10.
    """
    listed = _git("ls-files", ".claude/skills/coord/").stdout.split()
    for name in (*TRACKED, *OURS):
        assert (SKILL_DIR / name).is_file(), f"{name} is missing from the tree"
        assert f".claude/skills/coord/{name}" in listed, (
            f".claude/skills/coord/{name} exists on disk but git does not "
            f"track it. .gitignore ignores .claude/*, so it needs "
            f"`git add -f`. Tracked right now: {listed}"
        )


def test_upstream_doc_records_a_sha_for_every_tracked_file() -> None:
    """UPSTREAM.md carries a fork-point sha for each file the guard covers.

    A missing entry would make the guard skip that file in silence, which is
    the failure mode this whole test exists to prevent one level up.
    """
    recorded = recorded_shas()
    missing = sorted(set(TRACKED) - set(recorded))
    assert not missing, (
        f"{UPSTREAM_DOC.name} records no fork-point sha for {missing}. "
        f"Add one with: git rev-parse {UPSTREAM_REF}:{UPSTREAM_PREFIX}/<file>"
    )


def test_the_guard_actually_fires() -> None:
    """NEGATIVE CONTROL: a wrong recorded sha must be reported as drift.

    Without this, a `drifted` that returned False unconditionally would pass
    `test_upstream_copy_has_not_moved` on every run and detect nothing. A
    detector that always answers "nothing to see" is worse than no detector,
    because it is trusted.
    """
    if not _upstream_available():
        pytest.skip(
            f"{UPSTREAM_REF} is not in this clone, so the detector could not "
            f"be exercised at all. Run: git fetch adamdev master"
        )
    for name in TRACKED:
        assert drifted(name, "0" * 40) is True, (
            f"the drift detector did not fire on a deliberately wrong sha for "
            f"{name}. It cannot be trusted to fire on a real one."
        )


def test_the_guard_stays_quiet_when_nothing_moved() -> None:
    """POSITIVE CONTROL: the real recorded sha must report no drift.

    Paired with the negative control above, this is what shows the detector
    discriminates rather than simply answering the same way every time.
    """
    if not _upstream_available():
        pytest.skip(f"{UPSTREAM_REF} is not in this clone")
    recorded = recorded_shas()
    for name in TRACKED:
        current = upstream_sha(name)
        if current != recorded[name]:
            pytest.skip(
                f"{name} has genuinely drifted upstream, which the next test "
                f"reports. This control only means anything while it has not."
            )
        assert drifted(name, recorded[name]) is False


def test_upstream_copy_has_not_moved() -> None:
    """THE GUARD. adoom666's copy of the coord skill is still our fork point.

    A failure here is not a bug in this repo. It means the other party changed
    the tool both parties run, and somebody has to read the diff and decide
    what to take. `UPSTREAM.md` carries that procedure.
    """
    if not _upstream_available():
        pytest.skip(
            f"{UPSTREAM_REF} carries no {UPSTREAM_PREFIX}/ in this clone, so "
            f"upstream drift went UNMEASURED. This is not a pass. "
            f"Run: git fetch adamdev master"
        )
    recorded = recorded_shas()
    moved = [
        (name, recorded[name], upstream_sha(name))
        for name in TRACKED
        if drifted(name, recorded[name])
    ]
    assert not moved, (
        "adoom666's coord skill has moved off the sha we forked from.\n"
        + "\n".join(
            f"  {name}: forked from {was}, upstream now {now}" for name, was, now in moved
        )
        + f"\n\nThis is measured against the LOCAL {UPSTREAM_REF} ref, so it "
        f"reflects the last fetch and not necessarily GitHub right now.\n"
        f"Read his diff, decide what to take, keep the ccsliinc block in "
        f"coord.py, then update the shas in {UPSTREAM_DOC.name}.\n"
        f"Full procedure: {UPSTREAM_DOC}"
    )
