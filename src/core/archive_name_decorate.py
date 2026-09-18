"""Attach app-database names to an archive envelope, after the read.

WHERE THIS RUNS IS THE WHOLE SAFETY ARGUMENT. It runs on an envelope the
archive read has already FINISHED producing and closed its connection
for. So the ``ARCHIVE_ONLY`` connection never sees ``cloude.db``, the
app-side open never sees the archive, and neither holds the other's write
lock for a single statement. Decorating INSIDE the archive read - by
attaching, or by passing a second connection down - would put both files
under one lock scope again, which is the shape ``db_connection_shape``
was written to forbid and the shape that produced the 516-second hold in
issue #224.

IT ADDS FIELDS AND CHANGES NONE. ``display_name`` and ``title`` already
exist on these rows and mean something specific: the first is
``archive_project_names``' derivation from ``observed_cwd``, the second
is ``archive_titles``' four-record precedence over the transcript's own
content. Both are measurements of the ARCHIVE. Overwriting either with a
value from a different database would destroy the provenance those
modules exist to preserve, and would make ``title_source`` a lie. The new
values therefore arrive under their own names, with their own source
field, and a client chooses.

THE NEW NAME IS EXPECTED TO WIN, AND THE NUMBERS ARE WHY. Measured
2026-09-18 on live: the archive's own ``display_name`` is null for 100 of
100 projects, because ``observed_cwd`` is null for all of them; this
supplies a real name for 73. The archive's own transcript ``title``
covers 497 of 21,039 rows (2.36%); ``sessions.title`` names 882 of the
1,305 conversations the owner actually had (67.6%). But the archive's
values stay reachable, because a corpus collected from ANOTHER machine
has no row in this machine's ``cloude.db`` and the archive's own reading
is then the only one there is.

A DECORATION MUST NEVER REMOVE A ROW OR FAIL A LISTING. Every path here
returns the envelope it was handed. An unreadable app database yields
``cannot_determine`` per row and an unchanged list, so the rail shows
slugs - exactly what it showed before this module existed.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, MutableMapping

import structlog

from src.core.app_name_index import AppNameIndex
from src.core.archive_cwd_evidence import ArchiveCwdIndex
from src.core.archive_cwd_names import (
    DERIVED_KINDS,
    DERIVED_NAMES_MEAN,
    derive_name_from_cwd,
)
from src.core.archive_display_names import (
    MATCHED_CANNOT_DETERMINE,
    MATCHED_NONE,
    naming_meta,
    resolve_slug,
)
from src.core.claude_project_dirs import home_dir_aliases

logger = structlog.get_logger()

#: The archive records a conversation the owner had under this scheme.
#: Anything else is an ``agent`` sidechain - a file a conversation
#: spawned - which has no ``sessions`` row and never will, so it is not
#: looked up and reports ``none`` without a search.
SESSION_SCHEME_OWN: str = "uuid"

#: Where a session name came from. Named so a client cannot present the
#: app's browser title and the archive's own derived title as one thing.
SESSION_NAME_SOURCE: str = "app_database_sessions_title"

#: Shipped in ``meta`` beside the session names.
SESSION_NAMES_MEAN: str = (
    "app_session_title is sessions.title from the app database "
    "(cloude.db), joined on claude_session_uuid = the archive's "
    "session_ref, and it is the name shown in the app's own sidebar. It "
    "is null for an agent sidechain, which has no session row, and for a "
    "conversation this machine has no row for - a corpus collected "
    "elsewhere. It does NOT replace the row's own title, which is "
    "derived from the transcript's records and carries title_source."
)


def decorate_project_nodes(
    envelope: MutableMapping[str, Any], index: AppNameIndex
) -> MutableMapping[str, Any]:
    """Add app-database project names to a merged-projects envelope.

    Description: keyed on each node's ``full_path``, which is the archive
      slug carried through UNPARSED - the only honest key, since the slug
      cannot be decoded. Writes ``app_display_name``, ``app_description``
      and ``app_name_source`` onto every node, and a summary under
      ``meta.app_naming`` so a reader can see the rate rather than infer
      it from how many names happen to be present.
    Inputs: envelope (MutableMapping) - what ``merged_projects`` returned.
      index (AppNameIndex) - read once by the caller.
    Output: the SAME envelope, mutated and returned for chaining.
    Example: decorate_project_nodes(env, idx)["result"][0]["app_display_name"]
    """
    nodes = envelope.get("result")
    if not isinstance(nodes, list):
        # A cannot_determine envelope carries no list. Nothing to name,
        # and the refusal it already holds is the right answer.
        return envelope
    results: Dict[str, Dict[str, object]] = {}
    for node in nodes:
        if not isinstance(node, MutableMapping):
            continue
        slug = node.get("full_path")
        key = slug if isinstance(slug, str) else ""
        outcome = results.get(key)
        if outcome is None:
            outcome = resolve_slug(index.projects, key)
            results[key] = outcome
        node["app_display_name"] = outcome["display_name"]
        node["app_description"] = outcome["description"]
        node["app_name_source"] = outcome["matched_by"]
        node["app_project_id"] = outcome["project_id"]
        # Declared here, on EVERY node, so the derived rung only ever
        # overwrites a field the client already knows about. A field that
        # appears on some rows and not others reads to a client as a
        # backend that forgot to send it.
        node["app_name_evidence"] = None
        node["app_name_cwd"] = None
        node["app_name_anchor_project_id"] = None
    meta = envelope.setdefault("meta", {})
    if isinstance(meta, MutableMapping):
        meta["app_naming"] = naming_meta(index.projects, results)
    return envelope


def unnamed_slugs(envelope: Mapping[str, Any]) -> List[str]:
    """The slugs :func:`decorate_project_nodes` could not name.

    Description: exactly the population the cwd rung exists for, and the
      reason it is a separate pure function is cost. It is read BEFORE
      the archive is opened so a listing whose every slug the app
      database named opens no connection at all - the same "skip the
      read when nothing can use it" rule ``InstanceIndex`` follows. Only
      ``none`` qualifies: ``ambiguous`` is a refusal the app rung already
      reached on evidence, and re-asking a different question about it
      would be shopping for an answer.
    Inputs: envelope (Mapping) - a DECORATED merged-projects envelope.
    Output: list[str] - distinct slugs, in the order they appear.
    Example: unnamed_slugs(decorate_project_nodes(env, idx))  # 27 slugs
    """
    nodes = envelope.get("result")
    if not isinstance(nodes, list):
        return []
    out: List[str] = []
    seen: set = set()
    for node in nodes:
        if not isinstance(node, Mapping):
            continue
        if node.get("app_name_source") != MATCHED_NONE:
            continue
        slug = node.get("full_path")
        if isinstance(slug, str) and slug and slug not in seen:
            seen.add(slug)
            out.append(slug)
    return out


def decorate_project_nodes_from_cwd(
    envelope: MutableMapping[str, Any],
    index: AppNameIndex,
    cwds: ArchiveCwdIndex,
) -> MutableMapping[str, Any]:
    """Name the leftover slugs from the cwd their transcripts recorded.

    Description: runs AFTER :func:`decorate_project_nodes` and touches
      ONLY nodes it left at ``none``. A node the app database named is
      never reconsidered: a recorded name outranks a derived one, and
      letting this rung overwrite would make the whole ladder pointless.
      Writes ``app_name_evidence``, ``app_name_cwd`` and
      ``app_name_anchor_project_id`` beside the name so the provenance
      travels with it, and moves ``app_name_source``
      off ``none`` to one of the three values
      :mod:`src.core.archive_cwd_names` introduces - which is why the
      contract grew rather than quietly widening ``none``.
    Inputs: envelope (MutableMapping) - the DECORATED envelope. index
      (AppNameIndex) - for the anchor project lookup. cwds
      (ArchiveCwdIndex) - read once by the caller.
    Output: the SAME envelope, mutated and returned for chaining.
    Example: decorate_project_nodes_from_cwd(env, idx, cwds)
    """
    nodes = envelope.get("result")
    if not isinstance(nodes, list):
        return envelope
    results: Dict[str, Dict[str, object]] = {}
    # ONE $HOME symlink scan for the whole envelope. Per slug it was
    # 101 ms over 100 slugs against 3.6 ms hoisted on the owner's
    # 474-entry home directory - the same trap, and the same fix,
    # ``ProjectNameIndex`` already carries one rung up.
    aliases = home_dir_aliases()
    for node in nodes:
        if not isinstance(node, MutableMapping):
            continue
        if node.get("app_name_source") != MATCHED_NONE:
            continue
        slug = node.get("full_path")
        key = slug if isinstance(slug, str) else ""
        outcome = results.get(key)
        if outcome is None:
            outcome = derive_name_from_cwd(
                index.projects, cwds, key, aliases=aliases
            )
            results[key] = outcome
        if outcome["matched_by"] == MATCHED_CANNOT_DETERMINE:
            # The ARCHIVE could not be read. The app database WAS read
            # and really did answer "no project", so the node keeps that
            # measured `none` rather than being downgraded by a second
            # source's failure.
            continue
        node["app_name_source"] = outcome["matched_by"]
        node["app_display_name"] = outcome["display_name"]
        node["app_name_evidence"] = outcome["evidence"]
        node["app_name_cwd"] = outcome["observed_cwd"]
        # The anchor gets its OWN field. ``app_project_id`` means "this
        # slug IS project N" on the app rung; the anchor means "this slug
        # is INSIDE project N", and a client that navigated on the first
        # meaning would open the wrong project for every derived row.
        node["app_name_anchor_project_id"] = outcome["anchor_project_id"]
    meta = envelope.setdefault("meta", {})
    if isinstance(meta, MutableMapping):
        naming = meta.setdefault("app_naming", {})
        if isinstance(naming, MutableMapping):
            naming["derived_names_mean"] = DERIVED_NAMES_MEAN
            naming["archive_read"] = cwds.complete
            naming["by_derived_kind"] = _derived_counts(results)
    return envelope


def _derived_counts(results: Mapping[str, Mapping[str, object]]) -> Dict[str, int]:
    """How the cwd rung answered, counted by outcome.

    Description: every kind is listed with a zero rather than omitted, so
      a reader can see a rung that fired nothing without inferring it
      from an absent key.
    Inputs: results (Mapping) - slug to what the rung returned.
    Output: dict[str, int].
    """
    counts = {kind: 0 for kind in DERIVED_KINDS}
    counts[MATCHED_NONE] = 0
    counts[MATCHED_CANNOT_DETERMINE] = 0
    for result in results.values():
        key = str(result.get("matched_by"))
        if key in counts:
            counts[key] += 1
    return counts


def decorate_transcript_rows(
    envelope: MutableMapping[str, Any], index: AppNameIndex
) -> MutableMapping[str, Any]:
    """Add the app's own session name to a page of transcripts.

    Description: joins ``session_ref`` to ``sessions.claude_session_uuid``
      for rows whose scheme is :data:`SESSION_SCHEME_OWN`, and reports a
      named outcome for every row including the ones it does not name -
      an ``agent`` sidechain is ``none`` because it can never have a row,
      which is a different fact from a conversation this machine simply
      does not hold.
    Inputs: envelope (MutableMapping) - a transcript page envelope.
      index (AppNameIndex).
    Output: the SAME envelope, mutated and returned.
    Example: decorate_transcript_rows(env, idx)["result"][0]["app_session_title"]
    """
    rows = envelope.get("result")
    if not isinstance(rows, list):
        return envelope
    named = 0
    considered = 0
    for row in rows:
        if not isinstance(row, MutableMapping):
            continue
        considered += 1
        title, source = _session_name(row, index)
        row["app_session_title"] = title
        row["app_name_source"] = source
        if title:
            named += 1
    meta = envelope.setdefault("meta", {})
    if isinstance(meta, MutableMapping):
        meta["app_naming"] = {
            "session_names_mean": SESSION_NAMES_MEAN,
            "source": SESSION_NAME_SOURCE,
            "app_database_read": index.complete,
            "app_session_titles_held": index.session_title_count,
            "rows_considered": considered,
            "named": named,
        }
    return envelope


def _session_name(
    row: Mapping[str, Any], index: AppNameIndex
) -> tuple:
    """The app's name for one transcript row, and why it is or is not there.

    Description: the per-row ladder. An unreadable index refuses before
      the scheme is even read, so "nobody looked" cannot be reported as
      "this conversation has no name".
    Inputs: row (Mapping) - one transcript row. index (AppNameIndex).
    Output: tuple[str | None, str] - (title, source or refusal kind).
    """
    if not index.complete:
        return None, MATCHED_CANNOT_DETERMINE
    if row.get("session_ref_scheme") != SESSION_SCHEME_OWN:
        return None, MATCHED_NONE
    ref = row.get("session_ref")
    title = index.session_title(ref if isinstance(ref, str) else None)
    if not title:
        return None, MATCHED_NONE
    return title, SESSION_NAME_SOURCE
