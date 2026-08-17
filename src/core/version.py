"""Single source of version truth for Cloude Code.

THE RULE: a release is a GIT TAG. Everything that displays or compares a
version derives from that tag - the installer, upgrade.sh, rollback.sh, the
README and the version chip in the app's home bottom bar. Two version strings
that can disagree is a stale-doc bug waiting to happen, so there is exactly
one resolver and it lives here.

Resolution order, first hit wins:

1. ``CLOUDE_APP_VERSION`` environment variable. The LaunchAgent wrapper and
   the Electron shell both inject the installed tag this way.
2. A ``VERSION`` file at the repository root. GENERATED at release time by
   ``packaging/dmg/build-dmg.sh`` (and by ``upgrade.sh`` after a checkout)
   from the tag. Never hand-edit it; it carries a header saying so.
3. An EXACT git tag on HEAD (``git describe --tags --exact-match``). Covers
   an install whose VERSION file went missing but whose checkout is still
   parked on the release tag.
4. ``macOS/package.json``. Legacy fallback so the chip is not blank on an old
   layout, and so a dev tree sitting between releases shows a clean number.
5. A LOOSE ``git describe --tags``, for example "0.8.1-3-gabc1234". Last,
   deliberately: it is the most honest answer but the ugliest, and it is not
   a release tag, so the self check will correctly report "this install is
   not at a release tag" when it is what resolved.

Every step can fail. When all five fail the resolver returns "" and callers
render nothing rather than a wrong literal.

THE TWO GIT STEPS ARE PINNED TO THE ROOT. ``git -C <dir>`` searches upwards
for a repository, so a directory that merely sits inside some unrelated
checkout will happily answer with that checkout's tags. See
:func:`is_git_root`. Blank is a correct answer; another project's version is
not.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

# Written at the top of the generated VERSION file so nobody edits it by hand.
VERSION_FILE_HEADER = (
    "# GENERATED FROM THE GIT TAG AT RELEASE TIME. DO NOT EDIT BY HAND.\n"
    "# See src/core/version.py for the resolution order.\n"
)

VERSION_FILENAME = "VERSION"

# How long a `git describe` may take before we give up. A checkout on a slow
# or unmounted volume must not stall app startup.
_GIT_TIMEOUT_SECONDS = 5.0


def repo_root() -> Path:
    """Return the repository root that contains this source tree.

    Returns:
        The directory holding ``src/``, derived from this file's location.
        This is a path calculation only; it does not check the tree exists.
    """
    return Path(__file__).resolve().parents[2]


def normalize_tag(tag: str) -> str:
    """Strip a leading "v" and surrounding whitespace from a tag.

    Args:
        tag: raw tag, for example "v0.8.1" or " 0.8.1 ".

    Returns:
        The bare version string, for example "0.8.1". Empty input returns "".
    """
    return tag.strip().lstrip("vV").strip()


def read_version_file(root: Path | None = None) -> str:
    """Read the generated VERSION file.

    Args:
        root: repository root, defaults to :func:`repo_root`.

    Returns:
        The version string, or "" if the file is absent or unreadable. Comment
        lines starting with "#" and blank lines are skipped.
    """
    path = (root or repo_root()) / VERSION_FILENAME
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return normalize_tag(stripped)
    return ""


def write_version_file(version: str, root: Path | None = None) -> Path:
    """Write the generated VERSION file. Called by the release tooling.

    Args:
        version: the tag being released, with or without a leading "v".
        root: repository root, defaults to :func:`repo_root`.

    Returns:
        The path written.

    Raises:
        OSError: if the file cannot be written.
    """
    path = (root or repo_root()) / VERSION_FILENAME
    path.write_text(f"{VERSION_FILE_HEADER}{normalize_tag(version)}\n", encoding="utf-8")
    return path


def is_git_root(root: Path) -> bool:
    """Is ``root`` itself the top of a git work tree?

    THIS GUARD IS LOAD-BEARING, NOT A NICETY. ``git -C <dir>`` walks UPWARDS
    until it finds a repository, so an unversioned directory that merely SITS
    somewhere inside a checkout answers with that checkout's tags. In
    production the source root is a plain copy under Application Support with
    no ``.git`` of its own; if that copy is ever placed inside any repository
    the resolver would report a completely unrelated project's version, with
    no error, and a wrong literal is exactly what the "" fallback exists to
    prevent. So git is only consulted when the root IS the work tree.

    Args:
        root: the directory to test.

    Returns:
        True when ``git rev-parse --show-toplevel`` from ``root`` resolves to
        ``root`` itself. False when git is absent, the path is not a work
        tree, or the work tree is some ancestor.
    """
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0:
        return False
    toplevel = result.stdout.strip()
    if not toplevel:
        return False
    try:
        return Path(toplevel).resolve() == Path(root).resolve()
    except OSError:
        return False


def _git_describe(root: Path | None, args: list[str]) -> str:
    """Run one `git describe` variant and return its normalized output.

    Args:
        root: repository root, defaults to :func:`repo_root`.
        args: the describe arguments, for example ``["--tags", "--exact-match"]``.

    Returns:
        The described tag, or "" when git is missing, the directory is not
        ITSELF a work tree root, the call timed out, or nothing was described.
    """
    cwd = root or repo_root()
    if not is_git_root(cwd):
        return ""
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), "describe"] + args,
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if result.returncode != 0:
        return ""
    return normalize_tag(result.stdout)


def exact_git_tag(root: Path | None = None) -> str:
    """Return the tag HEAD is exactly at, or "" when HEAD is not tagged.

    Args:
        root: repository root, defaults to :func:`repo_root`.

    Returns:
        A bare tag such as "0.8.1", or "".
    """
    return _git_describe(root, ["--tags", "--exact-match", "HEAD"])


def describe_git_tag(root: Path | None = None) -> str:
    """Return the nearest tag plus commit distance, for example "0.8.1-3-gabc1234".

    Deliberately WITHOUT ``--always``. That flag makes describe fall back to a
    bare abbreviated commit sha when the repository has no tags at all, and a
    sha is not a version: it would be stamped into the header chip as if it
    were one. Without it, describe simply fails on an untagged repo and the
    resolver returns "", which renders as nothing.

    Args:
        root: repository root, defaults to :func:`repo_root`.

    Returns:
        The described string, or "" when nothing could be described.
    """
    return _git_describe(root, ["--tags"])


def read_package_json_version(root: Path | None = None) -> str:
    """Read the legacy version literal from macOS/package.json.

    Args:
        root: repository root, defaults to :func:`repo_root`.

    Returns:
        The version string, or "" if unreadable or malformed.
    """
    path = (root or repo_root()) / "macOS" / "package.json"
    try:
        with path.open("r", encoding="utf-8") as handle:
            return normalize_tag(str(json.load(handle).get("version", "")))
    except (OSError, ValueError):
        return ""


def resolve_version(root: Path | None = None) -> str:
    """Resolve the installed version. See module docstring for the order.

    Args:
        root: repository root, defaults to :func:`repo_root`.

    Returns:
        A bare version string such as "0.8.1", or "" when nothing resolved.
    """
    env_version = normalize_tag(os.environ.get("CLOUDE_APP_VERSION", ""))
    if env_version:
        return env_version
    return (
        read_version_file(root)
        or exact_git_tag(root)
        or read_package_json_version(root)
        or describe_git_tag(root)
    )
