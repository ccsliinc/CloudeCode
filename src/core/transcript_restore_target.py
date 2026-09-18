"""Where a restored transcript belongs, measured rather than derived.

THE DESTINATION IS A MEASUREMENT AND THE SLUG RULE IS A CORROBORATION.
That ordering is the whole design and it is the opposite of the obvious
one.

``transcript_archives.source_path`` is stored relative to the corpus root
and already carries the project directory the file was READ FROM:
``-Users-x-...-BHPP/10e4e7bf-....jsonl``. That is a record of where the
file literally was. Re-deriving a directory by slugifying a cwd is a
DERIVATION, and this project's rule is that a measurement outranks one.

It also disposes of the cwd-spelling trap (gotcha 6) completely rather
than navigating it. ``~/Development`` is a symlink into iCloud, Claude
Code slugs the LITERAL cwd string, so one directory has two project
directories and ``--resume`` finds a transcript only under the spelling
claude itself used. Whichever spelling that was is baked into the
recorded ``source_path``, so restoring to it restores to the directory
``--resume`` will look in, with no choice to get wrong.

THE SLUG RULE IS STILL RUN, AS A CROSS-CHECK THAT NEVER DECIDES.
:func:`corroborate_directory` slugifies every spelling of the cwd the
transcript itself records and reports whether the recorded directory is
among them. Agreement is a strong second signal. DISAGREEMENT IS NOT A
REFUSAL: 11 of 919 live transcripts sit in a directory that disagrees
with their own cwd because the session's cwd moved after startup, and
refusing on that would refuse real transcripts. It is reported, not
enforced.

CONTAINMENT IS COMPONENT-WISE. ``source_path`` is a database value, and a
database value is data: a ``..`` in it must not steer a write out of the
corpus. ``str.startswith`` is not the check - ``/Users/jsugamelevil``
starts with ``/Users/jsugamele`` - so the comparison is
``Path.relative_to`` on two resolved paths, the same shape
``src/core/project_directory.py`` already uses.

NOTHING HERE WRITES. It stats and it decides.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

import structlog

from src.core.claude_project_dirs import path_spellings
from src.core.claude_transcript_correlate import (
    default_projects_dir,
    slugify_project_dir,
)
from src.core.transcript_restore_outcomes import (
    ESCAPES_CORPUS_ROOT,
    PARENT_MISSING,
    SOURCE_IS_LONGER_THAN_ARCHIVE,
    TARGET_EXISTS,
    TARGET_READY,
)

logger = structlog.get_logger()

#: How many leading lines of a transcript are searched for a ``cwd``.
#: Claude writes it on the first record and on every record after, so one
#: is enough in practice; a handful covers a file whose first lines are
#: ``file-history-snapshot`` bookkeeping, which the import script measured
#: as a real shape (319 files carry no cwd anywhere). Bounded because
#: the largest transcript in this corpus is about 29 MB and a full parse
#: to learn one string would be absurd.
CWD_SCAN_LINES: int = 40

#: Agreement verdicts from :func:`corroborate_directory`. Three, not two:
#: "the transcript records no cwd" is not the same as "it records one and
#: it disagrees", and only the second is worth a human's attention.
CORROBORATION_AGREES: str = "agrees"
CORROBORATION_DISAGREES: str = "disagrees"
CORROBORATION_NO_CWD: str = "no_cwd_recorded"


@dataclass(frozen=True)
class Corroboration:
    """Whether the slug rule independently produces the recorded directory.

    Description: reporting only. ``verdict`` is one of the three
      CORROBORATION_* constants and no caller may refuse on it.
    Inputs: constructed by :func:`corroborate_directory`.
    Output: n/a (data holder).
    """

    verdict: str
    recorded_dir: str = ""
    cwd: Optional[str] = None
    derived_dirs: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class TargetDecision:
    """Where the bytes go, or why they may not go anywhere.

    Description: ``outcome`` is one of ALL_TARGET_OUTCOMES and is the
      only thing a caller may branch on. ``path`` is set whenever a path
      could be COMPOSED, including on a refusal, because a human being
      told "something is already there" needs to be told where.
    Inputs: constructed by :func:`resolve_target`.
    Output: n/a (data holder).
    """

    outcome: str
    path: Optional[Path] = None
    parent_exists: bool = False
    existing_byte_length: Optional[int] = None
    detail: str = ""


def default_corpus_root() -> Path:
    """The directory ``source_path`` values are relative to.

    Description: one name for ``~/.claude/projects`` shared with the
      reader side, resolved at call time so a test's ``$HOME`` override
      is seen.
    Inputs: none.
    Output: Path, not verified to exist.
    Example: default_corpus_root()  # Path('/Users/x/.claude/projects')
    """
    return default_projects_dir()


def _resolved(path: Path) -> Optional[Path]:
    """Canonicalise a path, or None when it cannot be canonicalised.

    Description: ``Path.resolve`` does not raise for a missing path but
      can raise ``OSError`` on a permission failure or a symlink loop,
      and every containment decision here needs a canonical spelling to
      compare. None is the undetermined signal, and undetermined refuses.
    Inputs: path (Path).
    Output: Path | None.
    Example: _resolved(Path('/tmp')) -> PosixPath('/private/tmp')
    """
    try:
        return Path(os.path.realpath(path))
    except OSError as exc:
        logger.debug("transcript_restore_realpath_failed", path=str(path), error=str(exc))
        return None


def _is_under(path: Path, root: Path) -> bool:
    """Report whether ``path`` sits at or beneath ``root``, component-wise.

    Description: NOT ``str.startswith``. ``/Users/jsugamelevil`` starts
      with ``/Users/jsugamele`` and is not inside it.
    Inputs: path (Path), root (Path) - both already canonical.
    Output: bool.
    Example: _is_under(Path('/a/b'), Path('/a')) -> True
    """
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def compose_target(source_path: str, corpus_root: Optional[Path] = None) -> Optional[Path]:
    """Join a stored ``source_path`` onto the corpus root, or refuse.

    Description: returns None when the join escapes the corpus root or
      when either side cannot be canonicalised. A None here is what
      becomes ESCAPES_CORPUS_ROOT; it is never silently substituted.
    Inputs: source_path (str) - the stored relative path. corpus_root
      (Path | None) - override for tests.
    Output: Path | None - the absolute destination.
    Example: compose_target('-Users-x/a.jsonl')
      # Path('/Users/x/.claude/projects/-Users-x/a.jsonl')
    """
    root = corpus_root if corpus_root is not None else default_corpus_root()
    root_real = _resolved(root)
    if root_real is None:
        return None
    if source_path.startswith("/"):
        return None
    candidate = root / source_path
    # Normalise without touching the filesystem first, so a '..' cannot
    # be smuggled through a directory that does not exist yet.
    lexical = Path(os.path.normpath(str(candidate)))
    if not _is_under(lexical, Path(os.path.normpath(str(root)))):
        return None
    parent_real = _resolved(lexical.parent)
    if parent_real is not None and not _is_under(parent_real, root_real):
        # The parent exists and is a symlink out of the tree.
        return None
    return lexical


def corroborate_directory(
    data: bytes, source_path: str, *, home: Optional[Path] = None
) -> Corroboration:
    """Check the slug rule independently reproduces the recorded directory.

    Description: reads the transcript's own ``cwd``, slugifies every
      spelling of it that :func:`path_spellings` knows, and reports
      whether the directory the archive recorded is one of them. PURELY
      INFORMATIONAL - see the module docstring for why a disagreement may
      not refuse.
    Inputs: data (bytes) - the reconstructed transcript. source_path
      (str) - the stored relative path. home (Path | None) - test
      override for the alias scan.
    Output: Corroboration.
    Example: corroborate_directory(b'{"cwd":"/a"}\\n', '-a/x.jsonl').verdict
      # 'agrees'
    """
    recorded_dir = source_path.split("/", 1)[0] if "/" in source_path else ""
    cwd = _first_cwd(data)
    if not cwd:
        return Corroboration(CORROBORATION_NO_CWD, recorded_dir=recorded_dir)
    derived = []
    for spelling in path_spellings(cwd, home=home):
        slug = slugify_project_dir(spelling)
        if slug not in derived:
            derived.append(slug)
    verdict = CORROBORATION_AGREES if recorded_dir in derived else CORROBORATION_DISAGREES
    return Corroboration(verdict, recorded_dir=recorded_dir, cwd=cwd, derived_dirs=derived)


def _first_cwd(data: bytes) -> Optional[str]:
    """The first ``cwd`` recorded in a transcript's leading records.

    Description: bounded to :data:`CWD_SCAN_LINES` lines. A line that is
      not valid JSON, or is JSON but not an object, contributes nothing
      and is stepped over - the archive deliberately preserves invalid
      JSON lines byte-exactly, so meeting one is normal rather than a
      fault.
    Inputs: data (bytes).
    Output: str | None.
    Example: _first_cwd(b'{"cwd":"/a"}\\n') -> '/a'
    """
    for index, raw in enumerate(data.split(b"\n")):
        if index >= CWD_SCAN_LINES:
            return None
        if not raw.strip():
            continue
        try:
            record = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(record, dict):
            value = record.get("cwd")
            if isinstance(value, str) and value:
                return value
    return None


def resolve_target(
    source_path: str,
    reconstructed_length: int,
    *,
    corpus_root: Optional[Path] = None,
    overwrite: bool = False,
    create_dirs: bool = False,
) -> TargetDecision:
    """Decide whether these bytes may be written, and where.

    Description: the refusal ladder. Containment first, because an
      escaping path must not even be stat'd as a destination; then the
      target's presence, which is the DEFAULT REFUSAL - a file that is
      there may be one claude is appending to right now; then, under
      ``overwrite`` only, the length comparison that keeps an opt-in to
      replace a file from becoming permission to shorten a conversation;
      then the parent directory.
    Inputs: source_path (str) - the stored relative path.
      reconstructed_length (int) - byte length of what would be written.
      corpus_root (Path | None) - override for tests. overwrite (bool) -
      the explicit, separate opt-in to replace an existing transcript.
      create_dirs (bool) - permission to create a missing project
      directory.
    Output: TargetDecision.
    Example: resolve_target('-a/x.jsonl', 10, corpus_root=tmp).outcome
      # 'target_ready'
    """
    target = compose_target(source_path, corpus_root=corpus_root)
    if target is None:
        return TargetDecision(
            ESCAPES_CORPUS_ROOT,
            detail=(
                f"{source_path!r} does not resolve to a path inside the corpus "
                "root; refusing to write outside the tree it was read from"
            ),
        )

    parent_exists = target.parent.is_dir()

    existing_length: Optional[int] = None
    try:
        existing_length = target.stat().st_size
    except FileNotFoundError:
        existing_length = None
    except OSError as exc:
        # The path is there in some form we cannot size. Undetermined,
        # so it refuses as though it existed, which is the safe side.
        return TargetDecision(
            TARGET_EXISTS,
            path=target,
            parent_exists=parent_exists,
            detail=f"{target} could not be stat'd ({exc}); refusing rather than guessing",
        )

    if existing_length is not None:
        if not overwrite:
            return TargetDecision(
                TARGET_EXISTS,
                path=target,
                parent_exists=parent_exists,
                existing_byte_length=existing_length,
                detail=(
                    f"{target} already exists ({existing_length} bytes). claude "
                    "may be appending to it right now. Pass --overwrite only "
                    "when you mean to replace it."
                ),
            )
        if existing_length > reconstructed_length:
            return TargetDecision(
                SOURCE_IS_LONGER_THAN_ARCHIVE,
                path=target,
                parent_exists=parent_exists,
                existing_byte_length=existing_length,
                detail=(
                    f"the file on disk is {existing_length} bytes and the archive "
                    f"reconstructs {reconstructed_length}. The archive is BEHIND "
                    "the live file; writing would truncate the conversation. "
                    "--overwrite is permission to replace a file, not to shorten one."
                ),
            )

    if not parent_exists and not create_dirs:
        return TargetDecision(
            PARENT_MISSING,
            path=target,
            parent_exists=False,
            detail=(
                f"{target.parent} does not exist. Pass --create-dirs to create "
                "the project directory."
            ),
        )

    return TargetDecision(
        TARGET_READY,
        path=target,
        parent_exists=parent_exists,
        existing_byte_length=existing_length,
    )
