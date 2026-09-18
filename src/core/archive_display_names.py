"""Real names for the archive's slugs, taken from the app database.

THE ARCHIVE HOLDS SLUGS AND ``cloude.db`` HOLDS THE MEANING. The message
browser addresses a project by the directory name Claude Code derived
from a cwd, an encoded absolute path like
``-Users-jsugamele-Library-Mobile-Documents-com-apple-CloudDocs-Sync-Development-CloudeCode``.
The app database has been carrying ``projects.display_name`` all along -
``'Media'``, ``'Fantasy Hockey 2026'`` - and nothing had ever joined the
two.

``message_projects.observed_cwd`` WAS THE INTENDED SOURCE AND IT IS
EMPTY. :mod:`src.core.archive_project_names` derives its display name
from that column; measured on the live archive 2026-09-18 it is NULL on
**100 of 100** rows, and ``archive_project_overlay`` holds **0** rows, so
every project in the rail renders as its raw slug. This module does not
replace that path, it supplies the name it could not produce. If
``observed_cwd`` is ever backfilled, both agree by construction: they
name the same directory.

DO NOT INVERT THE SLUG. The slugifier replaces every character outside
``[A-Za-z0-9-]`` with a single ``-``, so ``/``, ``_``, ``.``, a space and
a literal ``-`` all collapse onto the same character and nothing marks
which was which. ``-Users-x-Production-bhpp-new-server`` is really
``.../Production/bhpp_new_server``; ``-Users-x-Development-3D-Work`` is
``.../Development/3D Work``. Parsing that string is guessing.

SO THE JOIN RUNS FORWARD. Every ``projects.root`` and ``projects.raw_path``
is pushed through this project's OWN slug function
(:func:`src.core.claude_transcript_correlate.slugify_project_dir`, reached
via :func:`src.core.claude_project_dirs.path_spellings`, never a second
copy of the rule) and the RESULT is matched against the archive's
directory name. A lossy function is still a function: computing it in the
direction it was defined is exact.

ONE REAL DIRECTORY IS ONE NAME, WHICH IS THE WHOLE POINT OF THE
TIE-BREAK. ``~/Development`` is a symlink into iCloud, so one directory
has two spellings, and this data carries the scar: project 4
``'Hirschfeld (old path)'`` is rooted at the short spelling and project 6
``'Hirschfeld'`` at the long one, with project 4's own description saying
it was retired for exactly that reason. Both spellings of the slug
therefore match BOTH rows. Ranking by which row matched more literally
picks the old-path row for the short slug and the live row for the long
one - two names for one folder, which is the defect restated rather than
fixed.

:func:`resolve_slug` instead asks whether the candidates denote the same
real directory (``os.path.realpath`` of each root, compared) and, when
they do, keeps the row whose root is ALREADY CANONICAL. That is a
measured filesystem property, not a preference: it is the spelling
``src.core.project_directory`` has written since ``a4eeef1``, and it is
the row the old-path description points at. Measured on live: 3 slugs are
contested, all 3 resolve, and both Hirschfeld slugs answer
``'Hirschfeld'``.

CANDIDATES THAT DISAGREE ABOUT WHICH DIRECTORY THEY ARE REFUSE. Two
projects at genuinely different real paths colliding on one slug is a
collision the slug cannot adjudicate, so the answer is ``ambiguous`` and
the rail renders the slug. Zero on the live corpus, and it is the rung
that keeps the tie-break from degenerating into "pick one".

AN ANCESTOR IS NOT A NAME, AND THAT RUNG WAS BUILT AND THROWN AWAY. Nine
unresolved slugs are real subdirectories of named projects
(``.../Production/dev_tools/scripts``, ``.../Media/.claude/worktrees/...``).
Claiming the parent's name for them is wrong twice over: it labels a
distinct project with another project's name, and the slug prefix test
that finds them cannot tell a child directory from a sibling whose own
name merely starts the same way - ``-Users-x-Media`` prefixes both
``/Users/x/Media/sub`` and ``/Users/x/Media-Extra``, because the
separator and the literal hyphen are the same byte. A matcher that always
finds something is worse than useless, so those nine report ``none`` and
render their slug.

NOTHING HERE OPENS A DATABASE OR TOUCHES THE ARCHIVE. It is a pure
function over an index someone else read in bulk; see
:mod:`src.core.app_name_index` for the one connection that feeds it and
for why "the app database would not open" is a different answer from "no
project matched".
"""

from __future__ import annotations

import os
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import structlog

from src.core.claude_project_dirs import home_dir_aliases, path_spellings
from src.core.claude_transcript_correlate import slugify_project_dir

logger = structlog.get_logger()

#: A project row's own ``root`` or ``raw_path`` slugifies to this slug.
#: The strongest rung: the app recorded the very spelling Claude Code was
#: started in.
MATCHED_AS_WRITTEN = "as_written"

#: The slug was produced by a RESOLVED or ALIASED spelling of a project's
#: root - the symlink case. Still exact, still measured; it simply came
#: from a spelling the row does not literally store.
MATCHED_CANONICAL_SPELLING = "canonical_spelling"

#: No project row produces this slug. A MEASURED ABSENCE: the index was
#: read and nothing in it matches. The caller renders the slug.
MATCHED_NONE = "none"

#: Two or more projects at DIFFERENT real directories produce this slug,
#: and nothing here can say which the archive meant. Refuses rather than
#: picking, because a confident wrong name is worse than a slug.
MATCHED_AMBIGUOUS = "ambiguous"

#: The app database could not be read, so no question was asked. NEVER
#: collapsed into :data:`MATCHED_NONE` - "nothing matched" and "nobody
#: looked" render identically and mean opposite things.
MATCHED_CANNOT_DETERMINE = "cannot_determine"

#: Every value :func:`resolve_slug` can report, for a client that wants
#: to assert it understands the vocabulary before trusting a name.
MATCH_KINDS: Tuple[str, ...] = (
    MATCHED_AS_WRITTEN,
    MATCHED_CANONICAL_SPELLING,
    MATCHED_NONE,
    MATCHED_AMBIGUOUS,
    MATCHED_CANNOT_DETERMINE,
)

#: The rungs on which a name may actually be shown. A client that renders
#: a name for any other kind is rendering something nobody measured.
MATCH_KINDS_NAMED: Tuple[str, ...] = (
    MATCHED_AS_WRITTEN,
    MATCHED_CANONICAL_SPELLING,
)

#: Shipped in ``meta`` so a rail cannot present a resolved name as though
#: it had decoded the slug itself.
NAMES_MEAN: str = (
    "display_name comes from projects.display_name in the app database "
    "(cloude.db), matched by slugifying each project's recorded folder "
    "FORWARD and comparing the result to the archive's directory name. "
    "The slug is never parsed: it is a lossy encoding that maps '/', "
    "'_', '.', ' ' and '-' onto one character. matched_by says which "
    "rung answered; 'none' means no project row matched and the caller "
    "should render the slug, and 'cannot_determine' means the app "
    "database could not be read, which is not the same finding."
)


class ProjectNameIndex:
    """Every slug the app's project rows can produce, mapped to those rows.

    Description: built ONCE per listing from rows already in memory, then
      asked about each of the archive's slugs. Holds no connection and
      performs no query. ``complete`` travels with the data for the same
      reason it does on ``StatusMap`` and ``InstanceIndex``: an index that
      is empty because the read failed must not answer like an index that
      is empty because there are no projects.
    Inputs: rows (sequence of mapping) - each with ``id``, ``root``,
      ``raw_path``, ``display_name``, ``description``. complete (bool) -
      True only when a query actually RAN, a real answer of zero rows
      included. aliases (Sequence[tuple] | None) - a pre-scanned
      ``$HOME`` symlink table; None scans once here.
    Output: an index; use :func:`resolve_slug`.
    Example: ProjectNameIndex(rows, complete=True).slugs_known  # 142
    """

    def __init__(
        self,
        rows: Sequence[Mapping[str, object]],
        *,
        complete: bool,
        aliases: Optional[Sequence[Tuple[str, str]]] = None,
    ) -> None:
        self.complete = bool(complete)
        self._by_slug: Dict[str, List[Dict[str, object]]] = {}
        self._rows: List[Dict[str, object]] = []
        # ONE $HOME scan for the whole index. Per-project it was 131 ms
        # of a 139 ms build on the owner's 474-entry home directory.
        table = home_dir_aliases() if aliases is None else aliases
        for row in rows:
            record = self._record(row)
            if record is None:
                continue
            self._rows.append(record)
            for slug, as_written in self._slugs_for(record, table):
                bucket = self._by_slug.setdefault(slug, [])
                existing = next(
                    (b for b in bucket if b["project_id"] == record["project_id"]),
                    None,
                )
                if existing is None:
                    bucket.append({**record, "as_written": as_written})
                elif as_written:
                    # A project reached one slug by two routes. The
                    # literal one is the stronger statement about this
                    # row and must not be lost to iteration order.
                    existing["as_written"] = True

    @staticmethod
    def _record(row: Mapping[str, object]) -> Optional[Dict[str, object]]:
        """Normalise one project row, or None when it names no folder.

        Description: a row with neither ``root`` nor ``raw_path`` can
          produce no slug and is dropped rather than indexed under the
          empty string, which would match every unresolvable lookup.
        Inputs: row (Mapping) - one ``projects`` row.
        Output: dict | None.
        """
        root = _text(row.get("root"))
        raw = _text(row.get("raw_path"))
        if not root and not raw:
            return None
        anchor = root or raw or ""
        return {
            "project_id": row.get("id"),
            "root": root,
            "raw_path": raw,
            "display_name": _text(row.get("display_name")),
            "description": _text(row.get("description")),
            "real_root": _real(anchor),
            "root_is_canonical": bool(root) and _real(root) == root,
        }

    @staticmethod
    def _slugs_for(
        record: Mapping[str, object], aliases: Sequence[Tuple[str, str]]
    ) -> List[Tuple[str, bool]]:
        """Every slug this project can produce, flagged literal or derived.

        Description: the FORWARD half of the join. Each recorded spelling
          contributes its own slug as-written; :func:`path_spellings`
          contributes the resolved form and any ``$HOME`` symlink alias,
          which is what lets a project declared at the iCloud path match
          a transcript directory written under ``~/Development``.
        Inputs: record (Mapping) - a normalised project record. aliases
          (Sequence[tuple]) - the ``$HOME`` symlink table, scanned once
          by the caller.
        Output: list[tuple[str, bool]] - (slug, matched the recorded
          spelling literally).
        """
        out: List[Tuple[str, bool]] = []
        seen: Dict[str, bool] = {}
        for literal in (record.get("root"), record.get("raw_path")):
            text = _text(literal)
            if not text:
                continue
            for spelling in path_spellings(text, aliases=aliases):
                slug = slugify_project_dir(spelling)
                is_literal = spelling == text
                if slug not in seen:
                    seen[slug] = is_literal
                    out.append((slug, is_literal))
                elif is_literal and not seen[slug]:
                    seen[slug] = True
                    out = [(s, True if s == slug else w) for s, w in out]
        return out

    @property
    def slugs_known(self) -> int:
        """How many distinct slugs the project rows can produce.

        Description: a reporting figure only; a reader comparing it with
          the archive's slug count can see the two populations differ
          without inferring it from a resolution rate.
        Inputs: none. Output: int.
        """
        return len(self._by_slug)

    @property
    def project_count(self) -> int:
        """How many project rows were indexed.

        Inputs: none. Output: int.
        """
        return len(self._rows)

    def candidates(self, slug: str) -> List[Dict[str, object]]:
        """The project records that produce this slug, unranked.

        Description: exposed so a caller can report a contested slug
          without re-deriving the index.
        Inputs: slug (str). Output: list[dict].
        """
        return list(self._by_slug.get(slug, ()))


def _text(value: object) -> str:
    """A stripped string, or '' for anything that is not usable text.

    Description: ``projects`` columns are nullable and a whitespace-only
      name is not a name. One coercion so no caller invents a second.
    Inputs: value (object). Output: str.
    Example: _text(None)  # ''
    """
    return value.strip() if isinstance(value, str) else ""


def _real(path: str) -> str:
    """Canonical spelling of a path, or the input when it cannot resolve.

    Description: returning the INPUT on failure is deliberate. A path
      that cannot be resolved then compares equal only to itself, so an
      unresolvable root can never be fused with a different project, and
      an ``OSError`` here degrades recall rather than raising inside a
      read path.
    Inputs: path (str). Output: str.
    Example: _real('/Users/x/Development')  # '/Users/x/Library/.../Development'
    """
    if not path:
        return ""
    try:
        return os.path.realpath(path)
    except OSError as exc:
        logger.debug("archive_display_name_realpath_failed", error=str(exc))
        return path


def resolve_slug(index: ProjectNameIndex, slug: str) -> Dict[str, object]:
    """Name one archive project slug, or say why it cannot be named.

    Description: the ladder. An unreadable index answers
      ``cannot_determine`` before anything is compared; an empty
      candidate set answers ``none``; a single candidate is taken; and
      several candidates are adjudicated by real directory - same
      directory keeps the canonically-rooted row, different directories
      refuse. ``display_name`` is null on every rung except the two in
      :data:`MATCH_KINDS_NAMED`, so a caller that renders it blindly
      shows nothing rather than a guess.
    Inputs: index (ProjectNameIndex), slug (str) - the archive's
      directory name, used verbatim and never parsed.
    Output: dict with ``matched_by``, ``display_name``, ``description``,
      ``project_id`` and ``candidate_count``.
    Example: resolve_slug(idx, '-Users-x-Development-Assistants-Mac')
      # {'matched_by': 'canonical_spelling', 'display_name': 'Mac', ...}
    """
    if not index.complete:
        return _outcome(MATCHED_CANNOT_DETERMINE, None, 0)
    candidates = index.candidates(slug) if slug else []
    if not candidates:
        return _outcome(MATCHED_NONE, None, 0)
    if len(candidates) == 1:
        return _outcome(_kind(candidates[0]), candidates[0], 1)

    reals = {str(c.get("real_root") or "") for c in candidates}
    if len(reals) > 1:
        # Genuinely different folders, one slug. The slug cannot say
        # which, and neither may this.
        logger.debug(
            "archive_display_name_ambiguous",
            candidate_count=len(candidates),
            distinct_real_roots=len(reals),
        )
        return _outcome(MATCHED_AMBIGUOUS, None, len(candidates))

    canonical = [c for c in candidates if c.get("root_is_canonical")]
    if len(canonical) != 1:
        return _outcome(MATCHED_AMBIGUOUS, None, len(candidates))
    return _outcome(_kind(canonical[0]), canonical[0], len(candidates))


def _kind(candidate: Mapping[str, object]) -> str:
    """Which rung a winning candidate matched on.

    Inputs: candidate (Mapping) - a record from the index.
    Output: str - one of :data:`MATCH_KINDS_NAMED`.
    """
    return (
        MATCHED_AS_WRITTEN
        if candidate.get("as_written")
        else MATCHED_CANONICAL_SPELLING
    )


def _outcome(
    matched_by: str, winner: Optional[Mapping[str, object]], candidate_count: int
) -> Dict[str, object]:
    """Assemble one resolution result.

    Description: the single place a name is allowed onto a result, so a
      refusing rung cannot accidentally carry one.
    Inputs: matched_by (str), winner (Mapping | None), candidate_count
      (int). Output: dict.
    """
    named = matched_by in MATCH_KINDS_NAMED and winner is not None
    return {
        "matched_by": matched_by,
        "display_name": (winner.get("display_name") or None) if named else None,
        "description": (winner.get("description") or None) if named else None,
        "project_id": winner.get("project_id") if named else None,
        "candidate_count": candidate_count,
    }


def resolve_slugs(
    index: ProjectNameIndex, slugs: Sequence[str]
) -> Dict[str, Dict[str, object]]:
    """Resolve many slugs against one index.

    Description: the shape a listing wants. Pure dictionary work over an
      index already in memory - no connection is opened here, per slug or
      at all.
    Inputs: index (ProjectNameIndex), slugs (Sequence[str]).
    Output: dict - slug to the result :func:`resolve_slug` returns.
    Example: resolve_slugs(idx, ['-Users-x-p'])['-Users-x-p']['matched_by']
    """
    return {slug: resolve_slug(index, slug) for slug in slugs}


def naming_meta(
    index: ProjectNameIndex, results: Mapping[str, Mapping[str, object]]
) -> Dict[str, object]:
    """A per-response summary of how the naming actually went.

    Description: the rail is entitled to know the rate, not just the
      names, so a build that resolves nothing is visibly different from
      one that does not attempt the join. Counts every rung separately
      because ``none`` and ``cannot_determine`` are the pair most likely
      to be collapsed by a reader in a hurry.
    Inputs: index (ProjectNameIndex), results (Mapping) - what
      :func:`resolve_slugs` returned.
    Output: dict for ``meta.naming``.
    Example: naming_meta(idx, res)['resolved']  # 73
    """
    kinds = {kind: 0 for kind in MATCH_KINDS}
    for result in results.values():
        key = str(result.get("matched_by"))
        if key in kinds:
            kinds[key] += 1
    return {
        "names_mean": NAMES_MEAN,
        "source": "app_database_projects",
        "app_database_read": index.complete,
        "app_project_rows": index.project_count,
        "slugs_considered": len(results),
        "resolved": kinds[MATCHED_AS_WRITTEN] + kinds[MATCHED_CANONICAL_SPELLING],
        "by_match_kind": kinds,
    }
