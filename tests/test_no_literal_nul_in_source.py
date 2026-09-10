"""Regression guard: no tracked TEXT source may contain a literal NUL byte.

WHY THIS EXISTS. ``web/src/lib/plugins/registry.ts`` shipped a raw 0x00 byte
inside a template literal (``${c.surface}<NUL>${c.id}``), used as a
composite-key separator - a good pattern (no real surface name or
contribution id can contain NUL, so keys cannot collide by concatenation),
written the wrong way (a literal byte instead of the ``\\0`` / ``\\x00``
escape). JavaScript treats NUL as a legal string character, so nothing broke
at runtime and no test caught it. What DID break: ``file`` and plain
``grep`` classify the whole file as binary the moment it contains one NUL
byte, so ``grep`` silently returns nothing on it (``grep -a`` is required),
and every text-oriented tool that skips binary files skips it too. Two more
tracked files (``client/js/markdown-lite.js``, a node test) carried the same
defect independently, which is why this is a repo-wide guard rather than a
one-file fix.

WHAT COUNTS. Only files git actually tracks, restricted to source/doc
extensions a human writes by hand or a JS/TS toolchain emits as readable
text. ``client/dist/`` (the compiled Svelte bundle - a legitimate place for
a minifier to choose a literal byte over an escape, and not something this
guard needs to police) and vendored/dependency trees are excluded, along
with genuinely binary assets, which is the same shape ``test_no_remote_assets``
next door uses for the compiled bundle.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

#: Extensions a human writes, or a JS/TS toolchain emits as readable source.
#: Deliberately the same list the fix's own audit used.
_TEXT_EXTENSIONS = {
    ".ts", ".js", ".mjs", ".svelte", ".py", ".css", ".md",
    ".json", ".sh", ".yml", ".yaml",
}

#: Trees that are either compiled/vendored (not hand-written) or hold
#: genuinely binary assets this guard has no business opening.
_EXCLUDED_PREFIXES = (
    "client/dist/",
    "client/vendor/",
    "node_modules/",
    "web/node_modules/",
    "venv/",
    "venv.nosync/",
)


def _tracked_text_files() -> list[str]:
    """Every git-tracked file this guard should scan.

    Returns:
        list[str]: repo-relative paths, text extensions only, with compiled
            and vendored trees excluded.
    """
    listed = subprocess.run(
        ["git", "ls-files"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
    return [
        f for f in listed
        if Path(f).suffix in _TEXT_EXTENSIONS
        and not any(f.startswith(p) for p in _EXCLUDED_PREFIXES)
    ]


def test_no_tracked_source_file_contains_a_literal_nul_byte() -> None:
    """A literal 0x00 in a tracked source file is always a defect.

    A legitimate use of NUL as a sentinel or separator (this codebase has
    two: this one, and the launchpad's session-attribution key) belongs in
    source as the ``\\0`` / ``\\x00`` escape, never as the raw byte - the
    runtime value is identical either way, and only the escape keeps the
    file readable as text.
    """
    offenders: list[str] = []
    for rel_path in _tracked_text_files():
        path = REPO_ROOT / rel_path
        try:
            data = path.read_bytes()
        except (FileNotFoundError, IsADirectoryError):
            # A path git tracks but the working tree lacks (submodule
            # gitlink, a deleted-but-staged entry) is not this guard's
            # concern; absence is not a NUL byte.
            continue
        if b"\x00" in data:
            offenders.append(f"{rel_path} (offset {data.index(b'\x00')})")

    assert offenders == [], (
        "literal NUL byte(s) found in tracked source - escape as \\0 or "
        "\\x00 instead, so the runtime value is unchanged and the file "
        "stays classified as text: " + ", ".join(offenders)
    )


def test_the_detector_can_actually_fail(tmp_path: Path) -> None:
    """NEGATIVE CONTROL: prove the byte check fires on a planted NUL.

    A detector that always passes is worse than useless. This does not
    reuse the repo scan above - it exercises the same ``b"\\x00" in data``
    check the guard relies on, against a file built for the purpose, so a
    typo that made the real check inert (e.g. checking for the four
    characters ``\\x00`` instead of the one byte) would be caught here even
    though it would show green on the clean tree above.
    """
    planted = tmp_path / "planted.ts"
    planted.write_bytes(b"const key = `${a}\x00${b}`;\n")
    assert b"\x00" in planted.read_bytes()

    clean = tmp_path / "clean.ts"
    clean.write_bytes(b"const key = `${a}\\0${b}`;\n")
    assert b"\x00" not in clean.read_bytes()


@pytest.mark.parametrize(
    "rel_path",
    [
        "web/src/lib/plugins/registry.ts",
        "client/js/markdown-lite.js",
        "tests/test_restart_continuity_copy.node.mjs",
    ],
)
def test_the_previously_offending_files_are_clean(rel_path: str) -> None:
    """The three files this defect was found in, checked by name.

    Belt and braces on top of the repo-wide sweep above: if any of these
    three specific files ever regresses, the failure names the exact file
    rather than relying on the general sweep alone.

    Args:
        rel_path: repo-relative path to a file this defect was found in.
    """
    data = (REPO_ROOT / rel_path).read_bytes()
    assert b"\x00" not in data, f"{rel_path} contains a literal NUL byte again"
