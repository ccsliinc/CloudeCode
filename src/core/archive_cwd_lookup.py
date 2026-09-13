"""Find the archived project a live session's working directory belongs to.

WHY THIS IS SERVER SIDE. The terminal's "Deep dive" widens a search from
one session's scrollback to every past conversation in the same project
folder, which means turning a live session's ``working_dir`` into an
archive ``project_id``. A browser cannot do that: the two strings
routinely disagree, and reconciling them needs ``os.path.realpath`` and a
scan of the ``$HOME`` symlink table. Both are filesystem reads.

THE DISAGREEMENT IS THE WHOLE PROBLEM, AND IT IS THIS PROJECT'S OLDEST
ONE. ``~/Development`` on the owner's box is a symlink into iCloud, so
one directory has at least two literal spellings, and a project node's
``observed_cwd`` records whichever spelling was in force when Claude
Code wrote the transcript. A string equality test therefore answers "no
archived conversations for this folder" about a folder holding hundreds
of them, and it does so silently, which is the worst kind of wrong
answer for a control the user is deciding whether to trust.

THE LADDER IS ORDERED BY HOW STRONG THE EVIDENCE IS, and the rung that
answered is REPORTED rather than folded away. ``exact`` is the spelling
the session itself carries; ``realpath`` is that spelling resolved;
``alias`` is a ``$HOME`` symlink re-spelling of the resolved path. All
three are the same directory - the label says which reading found it, so
an operator reading a log can tell a plain hit from one that needed the
symlink table, and a wrong node can be traced to the rung that produced
it. NOTHING FUZZY IS ADDED: there is no prefix match, no basename match
and no "closest" node, because a matcher that always finds something is
worse than useless here, and the cost of a wrong project is a Deep dive
that searches a stranger's conversations.

Reuses ``src.core.claude_project_dirs`` rather than restating any of it:
``path_spellings`` is already the answer to "which cwd could the user
have typed to land here", and ``same_directory`` is already the backward
signal. A second implementation of either is a second set of symlink
bugs.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import structlog

from src.core import archive_merged_tree
from src.core.archive_read import RESULT_OK, envelope
from src.core.claude_project_dirs import path_spellings, same_directory

logger = structlog.get_logger()

#: The session's own spelling of the directory matched a node verbatim.
MATCH_EXACT: str = "exact"

#: The node matched the session's directory once symlinks were resolved.
MATCH_REALPATH: str = "realpath"

#: The node matched a ``$HOME`` symlink re-spelling of that directory.
MATCH_ALIAS: str = "alias"

#: Every label ``match_project_for_cwd`` can report, refusal excluded.
MATCH_KINDS: frozenset = frozenset({MATCH_EXACT, MATCH_REALPATH, MATCH_ALIAS})

#: The node fields this lookup answers with. Deliberately a SUBSET of the
#: merged node: the caller needs an addressable id and enough to name the
#: folder on screen, and shipping ``members`` would make this route a
#: second, drifting serialization of ``GET /archive/projects``.
NODE_FIELDS: Tuple[str, ...] = (
    "project_id", "display_name", "full_path", "observed_cwd",
)


def _realpath_or_none(path: str) -> Optional[str]:
    """Resolve a path's symlinks, or refuse rather than guess.

    Args:
        path: An absolute path string.

    Returns:
        The resolved path, or None when the OS would not answer. None is
        a refusal to claim a spelling, never a claim that there is none.

    Example:
        _realpath_or_none("/Users/x/Development")  # '/Users/x/Library/...'
    """
    try:
        return os.path.realpath(path)
    except OSError as exc:
        logger.debug("archive_cwd_realpath_failed", path=path, error=str(exc))
        return None


def _label_for(spelling: str, cwd: str, resolved: Optional[str]) -> str:
    """Name the rung a spelling came from.

    Description: derived from the spelling's VALUE rather than from its
      index in ``path_spellings``, so a change to that function's
      ordering cannot silently relabel a hit.
    Args:
        spelling: One entry from ``path_spellings``.
        cwd: The directory the caller asked about, as written.
        resolved: ``cwd`` with symlinks resolved, or None.

    Returns:
        One of ``MATCH_KINDS``.

    Example:
        _label_for("/Users/x/Dev", "/Users/x/Dev", "/real/Dev")  # 'exact'
    """
    if spelling == cwd:
        return MATCH_EXACT
    if resolved is not None and spelling == resolved:
        return MATCH_REALPATH
    return MATCH_ALIAS


def match_project_for_cwd(
    nodes: Sequence[Mapping[str, Any]],
    cwd: Optional[str],
    *,
    home: Optional[Path] = None,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Find the merged archive project node that denotes this directory.

    Description: walks the spellings of ``cwd`` in ``path_spellings``
      order - literal, resolved, then aliases - and returns the first
      node whose ``observed_cwd`` equals one of them. When no spelling
      matches literally it falls back to ``same_directory``, which
      resolves BOTH sides and therefore catches a node whose recorded cwd
      is itself a spelling the alias table does not produce. THE
      FALLBACK IS LAST because it is the only rung that resolves the
      node's own path, which costs a filesystem call per node and can
      only ever agree with a literal hit that already answered.

      A node with no ``observed_cwd`` is skipped: the merge keys those on
      their own project id precisely because they cannot be proved to be
      any particular folder, so matching one here would invent the
      evidence the merge refused to invent.
    Args:
        nodes: The merged project nodes from ``archive/projects``.
        cwd: The live session's working directory, or None.
        home: Override for the ``$HOME`` alias scan; tests only.

    Returns:
        ``(node, matched_by)`` where ``node`` is the caller's own dict
        from ``nodes`` and ``matched_by`` is one of ``MATCH_KINDS``; or
        ``(None, None)`` when nothing matched, which means the archive
        holds no conversations for that folder - a real answer, not a
        failure.

    Example:
        match_project_for_cwd(nodes, "/Users/x/Development/P")[1]  # 'alias'
    """
    if not cwd:
        return None, None

    resolved = _realpath_or_none(cwd)
    spellings: List[str] = path_spellings(cwd, home=home)

    for spelling in spellings:
        for node in nodes:
            observed = node.get("observed_cwd")
            if isinstance(observed, str) and observed == spelling:
                return dict(node), _label_for(spelling, cwd, resolved)

    for node in nodes:
        observed = node.get("observed_cwd")
        if isinstance(observed, str) and same_directory(observed, cwd):
            return dict(node), MATCH_REALPATH

    return None, None


def project_for_cwd_result(
    nodes: Sequence[Mapping[str, Any]],
    cwd: Optional[str],
    *,
    home: Optional[Path] = None,
) -> Dict[str, Any]:
    """Shape one lookup as the archive's three-outcome envelope.

    Description: NO MATCH IS ``ok`` WITH A NULL RESULT, not
      ``not_found`` and not ``cannot_determine``. The question asked is
      "which project is this folder", and "none of them" is a complete,
      measured answer to it; a 404 would say the LOOKUP does not exist,
      and a cannot_determine would say the server failed to evaluate it.
      Only the second of those would be a lie the client acts on - it
      hides the button for the same reason but reports a fault that did
      not happen. The datastore genuinely failing is still a
      cannot_determine, and it is produced by ``run_read`` above this,
      which is what keeps the two apart.
    Args:
        nodes: The merged project nodes.
        cwd: The live session's working directory.
        home: Override for the ``$HOME`` alias scan; tests only.

    Returns:
        An envelope whose ``result`` is the node fields plus
        ``matched_by``, or None. ``meta.matched_by`` carries the same
        label, and is null on a miss, so a client can read the rung
        without unpacking a nullable result.

    Example:
        project_for_cwd_result(nodes, "/x")["result_status"]  # 'ok'
    """
    node, matched_by = match_project_for_cwd(nodes, cwd, home=home)
    result: Optional[Dict[str, Any]] = None
    if node is not None:
        result = {field: node.get(field) for field in NODE_FIELDS}
        result["matched_by"] = matched_by
    return envelope(
        result=result,
        result_status=RESULT_OK,
        meta={
            "matched_by": matched_by,
            "candidate_count": len(nodes),
        },
    )


def project_for_cwd(
    conn: sqlite3.Connection, cwd: Optional[str], *, home: Optional[Path] = None
) -> Dict[str, Any]:
    """Read the merged project list and answer which node holds ``cwd``.

    Description: the one function ``run_read`` calls, so the route stays
      thin in the way ``archive_routes.py``'s header requires - bound the
      parameters, hand them to ONE core function inside a thread, return
      what came back.

      A MERGE THAT DID NOT FULLY ANSWER IS PASSED THROUGH UNCHANGED
      rather than being read as "no project". The two are different
      facts and only one of them means the Deep dive control should say
      the folder has no archived conversations; collapsing them would
      turn a datastore fault into a confident, wrong sentence on screen.
    Args:
        conn: An open read-only archive connection.
        cwd: The live session's working directory.
        home: Override for the ``$HOME`` alias scan; tests only.

    Returns:
        The envelope described by ``project_for_cwd_result``, or the
        merged-project envelope verbatim when that one was not ``ok``.

    Example:
        project_for_cwd(conn, "/Users/x/Dev/P")["meta"]["matched_by"]
    """
    merged = archive_merged_tree.merged_projects(conn)
    if merged.get("result_status") != RESULT_OK:
        return merged
    nodes = merged.get("result") or []
    return project_for_cwd_result(nodes, cwd, home=home)
