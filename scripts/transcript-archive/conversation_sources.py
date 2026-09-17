#!/usr/bin/env python3
"""Read every place a conversation can be observed, and nothing else.

WHY THIS IS ITS OWN MODULE. ``verify_all_conversations.py`` decides a VERDICT;
this file only answers "what did each source say". Keeping them apart is what
lets the self-test drive the verdict logic against throwaway sources, and it
keeps the identity rules (a stem is the identity, an ``agent-*`` is not a
conversation) in exactly one place rather than in each reader.

THE ONE RULE THAT MATTERS HERE: identity is the FILE STEM. Not the path, which
differs between the short ``~/Development`` spelling and the long iCloud spelling
of the same directory. Not the ``sessionId`` inside the file, which for an
``agent-*.jsonl`` is the PARENT's id and would collapse thousands of files onto
one. Every reader in this file reduces whatever it holds to a stem and hands
back sets of stems.
"""
from __future__ import annotations

import json
import os
import sqlite3
from typing import Dict, List, Sequence, Set, Tuple

#: Prefix that marks a subagent run rather than a conversation.
SUBAGENT_PREFIX = "agent-"


class CannotEvaluate(Exception):
    """A source could not be read, so no verdict may be given about it."""


def stem_of(source_path: str) -> str:
    """Reduce a transcript path to its identity: the file stem.

    Inputs:
      source_path: any path ending in ``<stem>.jsonl``, absolute or relative.
    Outputs:
      str: the stem, with the ``.jsonl`` suffix removed.
    Example:
      >>> stem_of("-Users-x-Proj/a1b2.jsonl")
      'a1b2'
    """
    base = os.path.basename(source_path or "")
    return base[:-6] if base.endswith(".jsonl") else base


def is_subagent(stem: str) -> bool:
    """True when a stem names a subagent run rather than a conversation.

    Inputs:
      stem: a transcript file stem.
    Outputs:
      bool: True for ``agent-*``.
    """
    return stem.startswith(SUBAGENT_PREFIX)


def split_stems(stems: Sequence[str]) -> Tuple[Set[str], Set[str]]:
    """Partition stems into conversations and subagent runs.

    Inputs:
      stems: an iterable of transcript stems.
    Outputs:
      (conversations, subagents): two disjoint sets.
    """
    conversations: Set[str] = set()
    subagents: Set[str] = set()
    for stem in stems:
        if not stem:
            continue
        (subagents if is_subagent(stem) else conversations).add(stem)
    return conversations, subagents


def read_archive(archive_path: str) -> Tuple[Set[str], Set[str], int]:
    """Read every transcript stem the live archive holds.

    Opened read-only with ``query_only``; ``immutable`` is deliberately NOT
    used, because this file is being written by the ingester and telling SQLite
    it is immutable against a moving file produced a segfault and a phantom
    17-row reading once already.

    Inputs:
      archive_path: path to cloude-archive.db.
    Outputs:
      (conversations, subagents, row_count).
    Raises:
      CannotEvaluate: the file is missing, unreadable or has no archive table.
    """
    if not os.path.exists(archive_path):
        raise CannotEvaluate(f"archive not found: {archive_path}")
    uri = "file://" + archive_path.replace(" ", "%20") + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=30.0)
    except sqlite3.Error as exc:
        raise CannotEvaluate(f"archive would not open: {exc}") from exc
    try:
        conn.execute("PRAGMA query_only=ON")
        have = conn.execute(
            "SELECT 1 FROM sqlite_master "
            "WHERE type='table' AND name='transcript_archives'").fetchone()
        if not have:
            raise CannotEvaluate(
                f"no transcript_archives table in {archive_path}")
        rows = conn.execute(
            "SELECT source_path FROM transcript_archives").fetchall()
    except sqlite3.DatabaseError as exc:
        raise CannotEvaluate(f"archive would not read: {exc}") from exc
    finally:
        conn.close()
    conversations, subagents = split_stems(stem_of(r[0]) for r in rows)
    return conversations, subagents, len(rows)


def read_corpus(corpus_root: str) -> Tuple[Set[str], Set[str], Dict[str, str]]:
    """Walk the on-disk corpus and collect every transcript stem.

    Inputs:
      corpus_root: directory holding ``<project-slug>/<stem>.jsonl`` trees.
    Outputs:
      (conversations, subagents, stem_to_path) where the map keeps one example
      path per stem so a gap can be reported with somewhere to look.
    Raises:
      CannotEvaluate: the root is missing or not a directory.
    """
    if not os.path.isdir(corpus_root):
        raise CannotEvaluate(f"corpus root not readable: {corpus_root}")
    stems: List[str] = []
    where: Dict[str, str] = {}
    for dirpath, _dirnames, filenames in os.walk(corpus_root, followlinks=True):
        for name in filenames:
            if not name.endswith(".jsonl"):
                continue
            stem = name[:-6]
            stems.append(stem)
            where.setdefault(stem, os.path.join(dirpath, name))
    conversations, subagents = split_stems(stems)
    return conversations, subagents, where


def read_census(census_path: str) -> dict:
    """Load the recorded census of offline sources.

    Inputs:
      census_path: path to conversation_census.json.
    Outputs:
      dict: the parsed census document.
    Raises:
      CannotEvaluate: missing, unparseable, or missing a required key. A census
        that cannot be read is never treated as a census holding nothing.
    """
    if not os.path.exists(census_path):
        raise CannotEvaluate(f"census not found: {census_path}")
    try:
        with open(census_path, "r", encoding="utf-8") as handle:
            doc = json.load(handle)
    except (OSError, ValueError) as exc:
        raise CannotEvaluate(f"census would not parse: {exc}") from exc
    for key in ("sources", "conversations"):
        if key not in doc:
            raise CannotEvaluate(f"census has no '{key}' key: {census_path}")
    return doc
