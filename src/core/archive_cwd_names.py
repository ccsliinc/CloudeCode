"""A display name for a slug no project row can name, from its real cwd.

THE SECOND RUNG, AND IT ONLY EVER RUNS BELOW THE FIRST.
:func:`src.core.archive_display_names.resolve_slug` names 73 of this
machine's 100 archive slugs from ``projects.display_name``. This names
some of the other 27, and the owner's design is his own sentence:
"Project names usually default to the last folder in the structure. but
this should be brought in from the main database." The database is the
first source and stays the first source. This is what happens when it has
nothing to say.

THE LAST FOLDER IS TAKEN FROM THE RECORDED cwd, NEVER FROM THE SLUG. The
slugifier collapses ``/``, ``_``, ``.``, a space and a literal ``-`` onto
one byte, so the slug's tail ``unifi-tunnel-reset`` is equally
``unifi_tunnel_reset``, ``unifi-tunnel-reset`` and ``unifi tunnel
reset``. :mod:`src.core.archive_cwd_evidence` reads the cwd Claude Code
wrote into the transcripts themselves, which is the only surviving record
of the real spelling; that directory has since been deleted from disk and
its underscore exists nowhere else on this machine.

A NAME IS COMPOSED, NOT COPIED, AND THE ANCHOR IS WHY. The owner's
complaint about the bare-leaf version is exact: ``scripts`` alone on a
row tells him nothing, and ``setup`` and ``.claude`` are two rows that
would read as unrelated strangers when both are folders inside
``.dotfiles``. So a derived name is ``<anchor> / <subpath>``: the deepest
project the app database NAMES that contains this directory, then the
real path components below it. ``Production / tools/dev_tools/scripts``,
``.dotfiles / setup``, ``Media / .claude/worktrees/vibrant-leakey-ea30bb``.

THAT IS NOT THE ANCESTOR RUNG THAT WAS THROWN AWAY. The earlier one
claimed the PARENT'S NAME for the child - labelling a distinct project
``Media`` - and found its parent by slug prefix, which cannot tell a
child from a sibling because ``-Users-x-Media`` prefixes both
``/Users/x/Media/sub`` and ``/Users/x/Media-Extra``. This one claims only
what it can prove: the anchor is found by component-wise containment on
REAL resolved paths, and the subpath is carried so the name says "the
``tools/dev_tools/scripts`` folder inside Production" and never
"Production".

A WORKTREE KEEPS ITS FULL SUBPATH ON PURPOSE. ``vibrant-leakey-ea30bb``
is a generated word salad and its parent ``worktrees`` is no better, so
the leaf alone is worthless and the two-segment version is worse than
useless. Rendering the whole subpath under the anchor puts ``Media``
first - the meaningful part - and ``.claude/worktrees/`` then says
plainly what kind of thing it is. NO SPECIAL CASE IS WRITTEN FOR IT: a
rule that recognised ``.claude/worktrees`` would be a hardcoded fix for
one family, and the general rule already renders that family correctly.

SCRATCH IS NAMELESS AND SAYS SO. 16 of the 27 unnamed slugs are
``/private/var/folders`` or ``/private/tmp`` per-run directories. They
are not projects, they were never meant to be, and inventing
``T / cc_rht_work_ko0irget`` for one would be the "matcher that always
finds something" this codebase keeps refusing. The test is
:func:`src.core.transcript_import_paths.is_scratch`, which the transcript
importer has used for this exact judgement since it shipped - reused, not
restated, so there is one list of scratch prefixes on this machine.
``scratch_path`` is its own outcome rather than ``none`` because "this is
a temp directory" and "nothing matched" are different things to tell a
reader.

A CONFLICT REFUSES. ``media-cleanup-qnap`` on this machine has 54
archives recording ``.../Production/media-cleanup-qnap`` and 34
recording ``.../Production/personal/media-cleanup-qnap`` - two real
directories, one slug, same leaf. Nothing here can say which the archive
meant, so it answers ``cwd_conflict`` and the rail renders the slug. The
symlink pair is NOT a conflict and must not be treated as one: 1,344
archives spell Media's directory short and 20 spell it long, and
``os.path.realpath`` proves those are one folder, which is the same
tie-break :func:`resolve_slug` already uses one rung up.

THE SLUG IS THE CONTROL, AND WITHOUT IT THIS WOULD NAME EVERYTHING. A
transcript filed under a slug may record a cwd from anywhere: a session
that changes directory mid-conversation writes the new one, and measured
across this corpus 32 of 99 slugs carry more than one distinct cwd, with
``Developer`` carrying ``/Users/x/Development/Web/imc-support/docs`` -
another project entirely. So an observed cwd is only EVIDENCE for a slug
when the slug can be recovered from it, and there are two ways that can
happen, reported separately as ``cwd_path_match`` and ``cwd_leaf_match``:

* ``cwd_path_match`` - pushing the cwd forward through this project's own
  slugifier reproduces the slug exactly. The same forward join
  :mod:`src.core.archive_display_names` uses, applied to the transcript's
  own record instead of a ``projects`` row. It discards every mid-session
  ``cd`` for free and folds the symlink spellings together by
  construction.
* ``cwd_leaf_match`` - no observed cwd reproduces the slug, but they all
  agree on a last folder whose slugified form is the slug's trailing
  segment. Three real projects need this and the reason is on disk: they
  ran under a symlinked ``Production/tools/`` and ``Production/web/``
  layer that no longer exists, so the recorded path and the filing slug
  genuinely differ by an interior component while naming the same folder.
  Weaker evidence, reported as such, and still a measurement rather than
  a parse.

NOTHING HERE OPENS A DATABASE. It is a pure function over two indexes
someone else read in bulk.
"""

from __future__ import annotations

import os
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import structlog

from src.core.archive_cwd_evidence import ArchiveCwdIndex
from src.core.archive_display_names import ProjectNameIndex
from src.core.archive_name_kinds import (
    MATCHED_CANNOT_DETERMINE,
    MATCHED_CWD_CONFLICT,
    MATCHED_DERIVED_CWD,
    MATCHED_NONE,
    MATCHED_SCRATCH_PATH,
)
from src.core.claude_project_dirs import home_dir_aliases, path_spellings
from src.core.claude_transcript_correlate import slugify_project_dir
from src.core.transcript_import_paths import canonical, is_scratch

logger = structlog.get_logger()

#: The cwd reproduced the slug through this project's own slugifier.
EVIDENCE_PATH_MATCH: str = "cwd_path_match"

#: No cwd reproduced the slug, but they agreed on a last folder that
#: slugifies to the slug's trailing segment.
EVIDENCE_LEAF_MATCH: str = "cwd_leaf_match"

#: Every outcome this module can report that the app-database rung
#: cannot. The three values live in
#: :mod:`src.core.archive_name_kinds` so there is ONE published
#: vocabulary; this tuple is the subset THIS rung introduces.
DERIVED_KINDS: Tuple[str, ...] = (
    MATCHED_DERIVED_CWD,
    MATCHED_SCRATCH_PATH,
    MATCHED_CWD_CONFLICT,
)

#: Separates the anchor from the subpath in a composed name. Spaced so
#: it cannot be misread as part of either folder's own name, and so a
#: client may split on it if it would rather render the two halves
#: differently.
NAME_SEPARATOR: str = " / "

#: Shipped in ``meta`` so a rail cannot present a derived name as though
#: the app database had supplied one.
DERIVED_NAMES_MEAN: str = (
    "app_display_name on app_name_source 'derived_cwd' is DERIVED, not "
    "recorded: it is the working directory Claude Code wrote into the "
    "transcripts filed under this slug, composed as '<project> / "
    "<subpath>' where <project> is the deepest app-database project "
    "containing that directory. The slug itself is never parsed. "
    "app_name_evidence says how the cwd was tied to the slug - "
    "'cwd_path_match' means it slugifies back to it exactly, "
    "'cwd_leaf_match' means only its last folder does. 'scratch_path' "
    "means the recorded directory is per-run scratch and has no project "
    "name; 'cwd_conflict' means two different real directories were "
    "recorded under one slug and neither may be claimed."
)


def derive_name_from_cwd(
    projects: ProjectNameIndex,
    cwds: ArchiveCwdIndex,
    slug: str,
    *,
    aliases: Optional[Sequence[Tuple[str, str]]] = None,
) -> Dict[str, object]:
    """Name one slug from the cwd its transcripts recorded, or refuse.

    Description: the ladder. An unreadable archive answers
      ``cannot_determine`` before anything is compared; no recorded cwd
      answers ``none``; scratch answers ``scratch_path``; cwds that
      denote two real directories answer ``cwd_conflict``; and a single
      corroborated directory is composed into a name. ``display_name``
      is null on every rung but :data:`MATCHED_DERIVED_CWD`, so a caller
      that renders it blindly shows nothing rather than a guess.
    Inputs: projects (ProjectNameIndex) - the app-database index, used
      for the anchor only. cwds (ArchiveCwdIndex) - read in bulk by the
      caller. slug (str) - the archive directory name, used verbatim and
      never parsed. aliases (Sequence[tuple] | None) - a pre-scanned
      ``$HOME`` symlink table; None scans once here.
    Output: dict with ``matched_by``, ``display_name``, ``evidence``,
      ``observed_cwd``, ``anchor_project_id`` and ``cwds_observed``.
    Example: derive_name_from_cwd(p, c, slug)['display_name']
      # 'Production / tools/dev_tools/scripts'
    """
    if not cwds.complete:
        return _outcome(MATCHED_CANNOT_DETERMINE, None, None, None, 0)
    observed = cwds.observed_cwds(slug) if slug else {}
    if not observed:
        return _outcome(MATCHED_NONE, None, None, None, 0)
    total = len(observed)
    table = home_dir_aliases() if aliases is None else aliases

    supported, evidence = _supporting_cwds(observed, slug, table)
    if not supported:
        return _outcome(MATCHED_NONE, None, None, None, total)

    # The spelling to SHOW is the one the transcripts actually wrote, and
    # the most-recorded of them when a symlink split them. Resolving it
    # for display would replace the folder the owner typed with an iCloud
    # path he has never seen on screen.
    chosen = max(supported, key=lambda cwd: (observed.get(cwd, 0), cwd))

    # Scratch is tested BEFORE the conflict rung, and on ALL the
    # supporting cwds rather than on the winner. Two throwaway run
    # directories disagreeing is not a conflict worth reporting: neither
    # was ever going to be named, and "cwd_conflict" would send a reader
    # looking for a project collision that does not exist.
    if all(is_scratch(cwd) for cwd in supported):
        return _outcome(MATCHED_SCRATCH_PATH, None, None, chosen, total)

    directories = {canonical(cwd) or cwd for cwd in supported}
    if len(directories) > 1:
        logger.debug(
            "archive_cwd_name_conflict",
            distinct_real_dirs=len(directories),
            cwds_observed=total,
        )
        return _outcome(MATCHED_CWD_CONFLICT, None, None, None, total)

    name, anchor_id = compose_name(projects, chosen)
    if not name:
        return _outcome(MATCHED_NONE, None, None, chosen, total)
    return _outcome(MATCHED_DERIVED_CWD, name, evidence, chosen, total, anchor_id)


def _supporting_cwds(
    observed: Mapping[str, int], slug: str, aliases: Sequence[Tuple[str, str]]
) -> Tuple[List[str], Optional[str]]:
    """Which observed cwds are evidence FOR this slug, and how strongly.

    Description: the control that stops this naming everything. A slug's
      transcripts may record a directory the session changed into, so an
      observed cwd counts only when the slug can be recovered from it.
      The strong test is tried across every cwd first: if ANY reproduces
      the slug exactly, the weaker leaf test is never consulted, so a
      mid-session ``cd`` can never dilute a path-matched answer.
    Inputs: observed (Mapping) - cwd to archive count. slug (str).
      aliases (Sequence[tuple]) - the ``$HOME`` symlink table.
    Output: tuple[list[str], str | None] - the supporting cwds and the
      evidence label, or ([], None) when none support the slug.
    """
    exact = [c for c in observed if _slugs_for_cwd(c, aliases) & {slug}]
    if exact:
        return exact, EVIDENCE_PATH_MATCH
    leaf = [c for c in observed if _leaf_matches_slug(c, slug)]
    if leaf:
        return leaf, EVIDENCE_LEAF_MATCH
    return [], None


def _slugs_for_cwd(cwd: str, aliases: Sequence[Tuple[str, str]]) -> set:
    """Every slug this directory could have been filed under.

    Description: the FORWARD half of the join, identical in direction to
      the one :mod:`src.core.archive_display_names` runs over
      ``projects`` rows, and reached through the same
      :func:`path_spellings` so the symlink table is consulted once and
      the rule exists once.
    Inputs: cwd (str) - a recorded working directory. aliases
      (Sequence[tuple]) - the ``$HOME`` symlink table.
    Output: set[str] - the slugs.
    Example: _slugs_for_cwd('/Users/x/p', [])  # {'-Users-x-p'}
    """
    return {slugify_project_dir(s) for s in path_spellings(cwd, aliases=aliases)}


def _leaf_matches_slug(cwd: str, slug: str) -> bool:
    """Does this cwd's last folder slugify to the slug's trailing segment?

    Description: the weaker corroboration, and the boundary test is what
      keeps it honest. ``msp-dashboard`` must match the slug's tail at a
      separator, so a slug ending ``-legacy-msp-dashboard`` is matched by
      a folder named ``msp-dashboard`` but a slug ending
      ``-supermsp-dashboard`` is not - without the boundary any leaf
      would match any slug that happened to end in its letters, which is
      the always-finds-something failure in miniature. A leaf equal to
      the WHOLE slug is accepted, which is the top-level directory case.
    Inputs: cwd (str) - a recorded working directory. slug (str).
    Output: bool.
    Example: _leaf_matches_slug('/a/b/unifi_tunnel_reset', '-a-b-unifi-tunnel-reset')
    """
    leaf = os.path.basename(cwd.rstrip("/"))
    if not leaf:
        return False
    leaf_slug = slugify_project_dir(leaf)
    if not leaf_slug or leaf_slug == "-":
        return False
    return slug == leaf_slug or slug.endswith("-" + leaf_slug.lstrip("-"))


def compose_name(
    projects: ProjectNameIndex, cwd: str
) -> Tuple[Optional[str], Optional[object]]:
    """Build the display name for one real working directory.

    Description: ``<anchor> / <subpath>`` when the app database names a
      project containing this folder, otherwise ``<parent> / <leaf>``
      from the directory's own real components. The fallback exists for a
      corpus collected on another machine, or a project deleted from
      ``cloude.db``, and is UNEXERCISED on the owner's data - all 8 of
      his derivable subdirectories land on a named anchor. It is covered
      by test rather than by hope, and that is said out loud because a
      rung nobody has watched fire is unmeasured, not proven.
    Inputs: projects (ProjectNameIndex) - the app-database index. cwd
      (str) - a recorded working directory, as written.
    Output: tuple[str | None, object | None] - the name and the anchor
      project's id, or (None, None) when the path has no usable leaf.
    Example: compose_name(idx, '/Users/x/.dotfiles/setup')
      # ('.dotfiles / setup', 7)
    """
    real = canonical(cwd) or cwd
    parts = [p for p in real.split("/") if p]
    if not parts:
        # A filesystem root names no folder. Refusing beats showing '/'.
        return None, None
    anchor = projects.named_ancestor(real)
    if anchor is not None:
        anchor_real = str(anchor.get("real_root") or "")
        depth = len([p for p in anchor_real.split("/") if p])
        subpath = "/".join(parts[depth:])
        if subpath:
            label = str(anchor.get("display_name") or "")
            return label + NAME_SEPARATOR + subpath, anchor.get("project_id")
    if len(parts) == 1:
        return parts[0], None
    return parts[-2] + NAME_SEPARATOR + parts[-1], None


def _outcome(
    matched_by: str,
    display_name: Optional[str],
    evidence: Optional[str],
    observed_cwd: Optional[str],
    cwds_observed: int,
    anchor_project_id: Optional[object] = None,
) -> Dict[str, object]:
    """Assemble one derivation result.

    Description: the single place a derived name is allowed onto a
      result, so a refusing rung cannot accidentally carry one.
    Inputs: matched_by (str), display_name (str | None), evidence
      (str | None), observed_cwd (str | None) - the cwd the outcome was
      reached from, kept on refusals too so a reader can see WHAT was
      refused. cwds_observed (int), anchor_project_id (object | None).
    Output: dict.
    """
    named = matched_by == MATCHED_DERIVED_CWD
    return {
        "matched_by": matched_by,
        "display_name": display_name if named else None,
        "evidence": evidence if named else None,
        "observed_cwd": observed_cwd,
        "anchor_project_id": anchor_project_id if named else None,
        "cwds_observed": cwds_observed,
    }
