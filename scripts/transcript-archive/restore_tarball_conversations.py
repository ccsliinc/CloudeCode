#!/usr/bin/env python3
"""Turn verified tarball members into an ingest manifest with true provenance.

WHAT THIS IS FOR. Seventy six conversations and five subagent runs exist only
inside three ``.tar.zst`` archives on the NAS. They were deleted from the working
tree in December 2025 and no live source holds them. Restoring them needs three
things done in order and none of them skipped: the bytes verified against the
tarball's own manifest, a ``source_path`` that says where they really came from,
and a round trip out of the archive that hash-matches the source. This module
does the middle one and hands the result to
:mod:`ingest_foreign_corpus`, which already owns the write.

THE PROVENANCE RULE, AND WHY IT IS NOT A FILESYSTEM PATH.
``transcript_archives.source_path`` is corpus-relative by convention, with
``~/.claude/projects`` as an implicit root. ``3ce7bcce`` established that a
transcript from somewhere else takes an ABSOLUTE path instead, because a leading
slash is self-describing and cannot be misread as relative (measured: 0 of
24,577 rows began with ``/`` before that ingest).

These files need the same rule and one extra decision, because their original
home is not equally knowable for all three tarballs:

* ``03-gogs-history-6d8879b`` is a git history of ``~/.claude`` on THIS machine,
  so the original home is ``/Users/jsugamele/.claude/projects/...``, knowable.
* ``04-mini-claude-backup-20260106`` holds ``.claude-backup-20260106/projects/``
  from the Mac mini. Which directory that backup sat in is NOT recorded anywhere.
* ``06-misc-claude2-and-app-sessions`` holds ``claude2/projects/``. Same problem.

Writing a guessed home for two of the three and a real one for the third would
put fabricated provenance in the column this project has already been burned by
(gotcha 6, the cwd-spelling split). So every restored row is rooted at the
RECOVERY ARTIFACT, which is a fact that can be re-verified forever:

    /mnt/ARCHIVE/vault/85_cloud-exports/claude/claude-archive-20260830/
        03-gogs-history-6d8879b.tar.zst#projects/<slug>/<uuid>.jsonl

The ``#`` separates the artifact from the member. It is deliberately NOT a
``/``: a path that reads as a directory tree would be a second kind of fiction,
since no such directory exists. The string is absolute, so the leading-slash
rule still holds; ``stem_of`` still recovers identity because it takes the
basename; and ``transcript_restore_target.compose_target`` still refuses it as
ESCAPES_CORPUS_ROOT, which is correct, because these rows genuinely do not
belong under the corpus root.

WHAT IS EXCLUDED, AND BY WHOSE RULE. Two members are ``history.jsonl``, the CLI
prompt history file, which is not a conversation. They are dropped by
:func:`build_conversation_census.looks_like_conversation`, IMPORTED rather than
re-expressed, so this script and the census can never disagree about what counts.

THE LEGACY SUBAGENT LAYOUT IS THE TRAP HERE. Current Claude Code writes a
subagent run to ``<session_uuid>/subagents/agent-x.jsonl``, and both
``ingest_foreign_corpus.classify_kind`` and its ``parent_source_path`` key on
that ``subagents/`` directory. The 2026-01 backup predates it: its five
``agent-*.jsonl`` files sit FLAT beside their parent sessions in the project
slug directory. Classified structurally they would be ingested as ``session``
kind, which is wrong, and their parent could not be derived at all. So kind is
decided by the stem (``conversation_sources.is_subagent``, imported) and the
parent is read from the file's OWN ``sessionId`` record, which is the only thing
in a flat layout that names it. Measured on all five: two name
``69eb03c6-38da-432b-b3e1-909b314c001c`` and three name
``bb4ce21e-1ee4-471f-8b09-43be77edf33f``, and both parents are themselves in
this restore set.

Usage::

    restore_tarball_conversations.py --tree DIR --manifest-dir DIR --out m.json
    # then
    ingest_foreign_corpus.py --manifest m.json           # dry run
    ingest_foreign_corpus.py --manifest m.json --apply   # writes
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from build_conversation_census import looks_like_conversation  # noqa: E402
from conversation_sources import is_subagent, stem_of  # noqa: E402

#: Absolute directory on the NAS holding the recovery artifacts. Recorded in
#: every restored ``source_path``, so it lives here exactly once.
NAS_ARCHIVE_DIR = ("/mnt/ARCHIVE/vault/85_cloud-exports/claude/"
                   "claude-archive-20260830")

#: Separator between a recovery artifact and a member inside it. NOT a slash:
#: see the module docstring.
MEMBER_SEP = "#"

#: The three tarballs this restore covers, as
#: (tree subdirectory, tarball basename, manifest basename).
TARBALLS: Tuple[Tuple[str, str, str], ...] = (
    ("03", "03-gogs-history-6d8879b.tar.zst", "03-files.sha256.tsv.gz"),
    ("04", "04-mini-claude-backup-20260106.tar.zst", "04-files.sha256.tsv.gz"),
    ("06", "06-misc-claude2-and-app-sessions.tar.zst", "06-files.sha256.tsv.gz"),
)


class RestoreError(Exception):
    """A restore input could not be trusted, so nothing is emitted."""


def normalise_member(path: str) -> str:
    """Strip a manifest entry's leading ``./`` and nothing else.

    A previous pass used ``str.lstrip("./")``, which strips every leading ``.``
    and ``/`` CHARACTER and therefore turned ``./.claude-backup-20260106/x`` into
    ``claude-backup-20260106/x``. All nine members of tarball 04 then failed to
    match their own manifest and were reported as "not in manifest", which reads
    exactly like a missing manifest rather than like a broken reader.

    Inputs:
      path: a member path as written in a manifest.
    Outputs:
      str: the member path with one leading ``./`` removed.
    Example:
      >>> normalise_member("./.claude-backup/x.jsonl")
      '.claude-backup/x.jsonl'
    """
    return path[2:] if path.startswith("./") else path


def read_manifest(manifest_path: str) -> Dict[str, Tuple[str, int]]:
    """Load one tarball manifest's ``.jsonl`` entries.

    Inputs:
      manifest_path: path to a gzipped ``sha256 <TAB> size <TAB> path`` file.
    Outputs:
      dict: member path -> (sha256, byte size).
    Raises:
      RestoreError: the manifest is missing or unreadable. A manifest that
        cannot be read is never treated as a manifest holding nothing.
    """
    if not os.path.exists(manifest_path):
        raise RestoreError(f"manifest not found: {manifest_path}")
    out: Dict[str, Tuple[str, int]] = {}
    try:
        with gzip.open(manifest_path, "rt", errors="replace") as handle:
            for line in handle:
                parts = line.rstrip("\n").split("\t")
                if len(parts) == 3 and parts[2].endswith(".jsonl"):
                    out[normalise_member(parts[2])] = (parts[0], int(parts[1]))
    except (OSError, ValueError) as exc:
        raise RestoreError(f"manifest would not read: {exc}") from exc
    if not out:
        raise RestoreError(f"manifest holds no .jsonl entries: {manifest_path}")
    return out


def parent_session_uuid(file_path: str) -> Optional[str]:
    """Read the parent session uuid a flat-layout subagent run records.

    Description: an ``agent-*.jsonl`` records its PARENT's ``sessionId`` on every
      record, which is precisely why sessionId is useless as an identity and
      exactly what is wanted as a parent pointer. The first record that carries
      one wins; a file with none returns None rather than a guess.
    Inputs:
      file_path: absolute path to the subagent transcript.
    Outputs:
      str | None: the parent session uuid, or None when no record names one.
    """
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as handle:
            for _ in range(20):
                line = handle.readline()
                if not line:
                    break
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                sid = record.get("sessionId")
                if isinstance(sid, str) and sid:
                    return sid
    except OSError:
        return None
    return None


def build_rows(tree_root: str, manifest_dir: str) -> Tuple[List[Dict], Dict]:
    """Verify every extracted member and compose its ingest manifest row.

    Description: the hash compared against is the TARBALL MANIFEST's, taken at
      the time the tarball was cut, not one recomputed here. Recomputing and
      comparing to itself would pass unconditionally. A member whose bytes
      disagree with its manifest raises rather than being quietly skipped.
    Inputs:
      tree_root: directory holding ``03/``, ``04/`` and ``06/`` extractions.
      manifest_dir: directory holding the three gzipped manifests.
    Outputs:
      (rows, summary): rows in :mod:`ingest_foreign_corpus` manifest shape, and
        a summary dict of what was verified, kept and excluded.
    Raises:
      RestoreError: a hash mismatch, a member absent from its manifest, or a
        manifest entry that was not extracted.
    """
    rows: List[Dict] = []
    summary: Dict = {"verified": 0, "conversations": 0, "subagents": 0,
                     "excluded_not_a_conversation": [], "per_tarball": {}}
    by_stem: Dict[str, Dict] = {}

    for subdir, tarball, manifest_name in TARBALLS:
        want = read_manifest(os.path.join(manifest_dir, manifest_name))
        root = os.path.join(tree_root, subdir)
        if not os.path.isdir(root):
            raise RestoreError(f"extraction tree not found: {root}")
        seen = set()
        kept = 0
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in sorted(filenames):
                if not name.endswith(".jsonl"):
                    continue
                full = os.path.join(dirpath, name)
                member = os.path.relpath(full, root)
                seen.add(member)
                expected = want.get(member)
                if expected is None:
                    raise RestoreError(
                        f"{tarball}: {member} is not in its manifest")
                data = open(full, "rb").read()
                got = hashlib.sha256(data).hexdigest()
                if got != expected[0] or len(data) != expected[1]:
                    raise RestoreError(
                        f"{tarball}: {member} does not match its manifest "
                        f"({got}/{len(data)} vs {expected[0]}/{expected[1]})")
                summary["verified"] += 1
                stem = stem_of(name)
                if not is_subagent(stem) and not looks_like_conversation(member):
                    summary["excluded_not_a_conversation"].append(
                        f"{tarball}{MEMBER_SEP}{member}")
                    continue
                source_path = (f"{NAS_ARCHIVE_DIR}/{tarball}"
                               f"{MEMBER_SEP}{member}")
                row = {
                    "rel": member,
                    "abs_recovered": full,
                    "source_path": source_path,
                    "kind": "subagent" if is_subagent(stem) else "session",
                    "sha256": expected[0],
                    "bytes": expected[1],
                    "tarball": tarball,
                    "stem": stem,
                }
                if row["kind"] == "subagent":
                    row["parent_session_uuid"] = parent_session_uuid(full)
                    summary["subagents"] += 1
                else:
                    summary["conversations"] += 1
                    by_stem[stem] = row
                rows.append(row)
                kept += 1
        not_extracted = sorted(set(want) - seen)
        if not_extracted:
            raise RestoreError(
                f"{tarball}: {len(not_extracted)} manifest entries were not "
                f"extracted, first {not_extracted[0]}")
        summary["per_tarball"][tarball] = {
            "manifest_jsonl": len(want), "verified": len(seen), "kept": kept}

    # Resolve each subagent's parent to a source_path in THIS restore set. A
    # parent outside the set leaves the field absent, and the ingest then leaves
    # the row unrooted rather than pointing it at nothing.
    for row in rows:
        if row["kind"] != "subagent":
            continue
        parent = by_stem.get(row.get("parent_session_uuid") or "")
        if parent is not None:
            row["parent_source_path"] = parent["source_path"]
    summary["subagents_with_parent_in_set"] = sum(
        1 for r in rows if r["kind"] == "subagent" and "parent_source_path" in r)
    rows.sort(key=lambda r: r["source_path"])
    return rows, summary


def main(argv: Optional[List[str]] = None) -> int:
    """CLI entry point.

    Inputs:
      argv: argument vector.
    Outputs:
      int: 0 on success, 2 when an input could not be trusted.
    """
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--tree", required=True,
                        help="directory holding 03/ 04/ 06/ extractions")
    parser.add_argument("--manifest-dir", required=True,
                        help="directory holding the gzipped tarball manifests")
    parser.add_argument("--out", required=True, help="ingest manifest to write")
    args = parser.parse_args(argv)

    try:
        rows, summary = build_rows(args.tree, args.manifest_dir)
    except RestoreError as exc:
        print(f"REFUSING: {exc}", file=sys.stderr)
        return 2
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(rows, handle, indent=1, sort_keys=True)
    print(json.dumps(summary, indent=1))
    print(f"\n{len(rows)} rows written to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
