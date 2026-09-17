#!/usr/bin/env python3
"""Build or refresh the census and roster ``verify_all_conversations.py`` reads.

WHY A FILE AND NOT A SCAN. The census records every conversation ever OBSERVED
in a source that is not always reachable: databases and tarballs on the NAS, and
local database backups that get rotated away. A checker that can only answer
when the NAS is up is a checker nobody runs, so the observation is made once,
written down, and committed.

IT IS APPEND-ONLY ON BOTH SETS, WHICH IS THE WHOLE POINT. A stem that was
observed in July and has since been deleted from every source still belongs
here, because the question is "did this ever exist", and a census that forgot it
would make its loss invisible. So a refresh MERGES: it adds newly observed stems
and updates source metadata, and it never drops a stem it already knows.

SUBAGENT RUNS ARE NOW FULLY ENUMERATED, WHICH REVERSES THE OLD NAMED LIMIT. This
file used to say: about 19,000 subagent runs against about 1,300 conversations,
so enumerating them would make a 450 KB file that churns on every ingest, and
therefore only the COUNT and the known-missing stems were kept. The owner
overruled that, verbatim: "i also want to confirm all conversations are in the
database. even subagent because the archive viewer is an in depth detailed
viewer."

The churn is solved rather than the coverage dropped, and the split is:

  identity     ``subagent_roster.txt``, one stem per line, sorted, no metadata,
               append only. A refresh that sees twelve new runs is a twelve line
               diff. :mod:`subagent_roster` explains why that works.
  provenance   ``census["subagents"]``, where-to-find-it for the runs that are
               MISSING from the live archive only. A run the archive holds needs
               no recovery pointer.
  drift alarm  ``subagent_set_sha256`` per source: 64 bytes that say whether a
               static source read the same way twice. It cannot name a stem;
               the roster does that.

EXCLUSIONS ARE STRUCTURED DATA. A population deliberately left out - today the
195 OpenAI Codex CLI conversations - is a record with the owner's ruling
verbatim, an ``in_scope`` flag and a count re-taken every run. It used to be a
parenthesis inside a source NAME, which nothing could query. See
:mod:`census_exclusions`.

READ ONLY against every database. NAS refresh runs read-only queries over ssh
and copies nothing back but stem lists.

Usage:
  python3 build_conversation_census.py --out conversation_census.json
  python3 build_conversation_census.py --out ... --nas truenas_admin@10.0.1.237
  python3 build_conversation_census.py --merge-stems "nas 09-...=/path/list.txt"
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Dict, List, Optional, Sequence, Set

from census_exclusions import build_exclusions
from census_nas_sources import (NAS_DATABASES, NAS_MANIFESTS, NAS_ROOT,
                                looks_like_conversation, nas_database_stems,
                                nas_manifest_stems)
from conversation_sources import CannotEvaluate, read_archive, read_corpus
from subagent_roster import (default_roster_path, read_stem_file, set_digest,
                             subagent_stems_from_paths, write_roster)
from verify_all_conversations import (DEFAULT_ARCHIVE, DEFAULT_CORPUS_ROOT,
                                      DISPOSITION_OPEN)

#: Sources that CANNOT be re-read on a routine refresh because reading them
#: costs a 22 GB decompression, a 4.5 GB git checkout or a 25 GB tar stream, and
#: whose readings are therefore RECORDED rather than re-derived. Each carries the
#: date it was measured, the command that measured it, and the verdict. A
#: recorded reading is weaker evidence than a fresh one and is labelled as such
#: on every run, so nobody mistakes it for something this build just checked.
#:
#: Their subagent stems reach the roster through ``--merge-stems``, run once by
#: an operator against the decompressed artifact. That is what closes the old
#: hole where three sources contributed a subagent COUNT and no identities.
MEASURED_ONCE: tuple = (
    {
        "name": "nas 09-claude-history-db-20260902",
        "kind": "offline database, recorded reading",
        "location": ("truenas_admin@10.0.1.237:" + NAS_ROOT +
                     "/claude-archive-20260902/09-claude-history-db-20260902.sqlite.zst"),
        "measured_at": "2026-09-17",
        "how": ("zstd -dc the 4.6 GB archive to a 21,988,401,152 byte sqlite "
                "file, then read sessions.source_file_path read-only"),
        "conversations": 1200,
        "subagents": 18414,
        "conversations_missing_from_live": [],
        "note": ("the claude-history MCP index, a third conversation database "
                 "holding 5,967,605 messages over 19,656 sessions dated "
                 "2025-12-10 to 2026-09-02. every conversation in it is in the "
                 "live archive."),
    },
    {
        "name": "nas claude-config git history, all 131 commits",
        "kind": "offline git repository, recorded reading",
        "location": ("truenas_admin@10.0.1.237:" + NAS_ROOT +
                     "/claude-config-git-20260831/claude-config-git-20260831.tar.zst"),
        "measured_at": "2026-09-17",
        "how": ("extract the 4.5 GB .git, then git log --all --name-only "
                "--diff-filter=AMD over every commit from 2025-08-29 to "
                "2026-08-29"),
        "conversations": 1284,
        "subagents": 18197,
        "conversations_missing_from_live": [],
        "note": ("the full history, not just the one tree tarball 03 was cut "
                 "from. it holds the same 72 conversations tarball 03 holds and "
                 "no others: the 8 remaining .jsonl stems are "
                 ".claude/transcripts/archives/latest_<uuid>.jsonl backup COPIES "
                 "made by the owner's own tooling in January 2026, and all six "
                 "underlying conversation uuids are in the live archive."),
    },
    {
        "name": "nas tarball 11-formmanager-scratch-repo",
        "kind": "offline tarball, recorded reading",
        "location": ("truenas_admin@10.0.1.237:" + NAS_ROOT +
                     "/claude-archive-20260902/11-formmanager-scratch-repo-20260902.tar.zst"),
        "measured_at": "2026-09-17",
        "how": ("the one tarball with no per-file manifest. streamed "
                "zstd -dc | tar -tf without writing 25 GB to disk, then matched "
                "every uuid-named .jsonl member against the live archive"),
        "conversations": 222,
        "subagents": 2045,
        "conversations_missing_from_live": [],
        "note": ("985,973 members, 2,395 real .jsonl once AppleDouble ._ "
                 "sidecars are dropped. NONE sits under a projects/ directory: "
                 "they are copies staged under Scratch/llmScratch/hostdim/ and "
                 "Scratch/llmScratch/claude-projects-quarantine-20260902/. all "
                 "222 uuid-named transcripts are in the live archive."),
    },
)


def local_backup_stems(state_dir: str) -> List[dict]:
    """Read stems from every rotated database in the state dir.

    Inputs:
      state_dir: the CloudeCode application support directory.
    Outputs:
      list of source dicts, one per readable backup database.
    """
    out: List[dict] = []
    if not os.path.isdir(state_dir):
        return out
    for name in sorted(os.listdir(state_dir)):
        if not (name.endswith(".db") or ".db.bak-" in name):
            continue
        if name == "cloude-archive.db":
            continue
        path = os.path.join(state_dir, name)
        if not os.path.isfile(path) or os.path.getsize(path) < 4096:
            continue
        try:
            conv, sub, _rows = read_archive(path)
        except CannotEvaluate:
            continue
        if not conv and not sub:
            continue
        out.append({"name": f"local backup {name}", "kind": "local database",
                    "location": path, "conversation_stems": sorted(conv),
                    "subagent_stems": sorted(sub)})
    return out


def merge(existing: dict, sources: Sequence[dict], now: str) -> dict:
    """Merge freshly observed sources into an existing census, append-only.

    Inputs:
      existing: the previous census, or an empty dict.
      sources: source dicts from the readers above.
      now: ISO timestamp for this observation.
    Outputs:
      dict: the merged census document.
    """
    doc = {
        "schema": 2,
        "generated_at": now,
        "definition": (
            "a conversation is one real Claude Code session transcript, "
            "identified by its .jsonl file stem. agent-*.jsonl subagent runs "
            "are a second population, identified the same way, enumerated in "
            "subagent_roster.txt beside this file. the two are never summed."),
        "sources": [],
        "conversations": dict(existing.get("conversations", {})),
        "subagents": dict(existing.get("subagents", {})),
    }
    for source in sources:
        stems = source.get("conversation_stems", [])
        sub_stems = source.get("subagent_stems", [])
        files = source.get("files", {})
        doc["sources"].append({
            "name": source["name"], "kind": source["kind"],
            "location": source.get("location"),
            "conversations": len(stems),
            "subagents": len(sub_stems),
            "subagent_set_sha256": set_digest(sub_stems),
            "observed_at": now,
            "conversation_stems_missing_from_live": [],
        })
        for stem in stems:
            record = doc["conversations"].setdefault(
                stem, {"sources": [], "disposition": DISPOSITION_OPEN,
                       "first_observed": now})
            if source["name"] not in record["sources"]:
                record["sources"].append(source["name"])
            if stem in files and not record.get("where"):
                record["where"] = f"{source['name']} :: {files[stem]['path']}"
                record["bytes"] = files[stem]["bytes"]
                record["sha256"] = files[stem]["sha256"]
                # A manifest entry carries the file's own sha256, so restoring
                # it can be PROVEN byte for byte rather than assumed. That is a
                # stronger claim than "we have a copy" and is recorded as such.
                record["recoverability"] = "byte_exact_recoverable"
            record["last_observed"] = now
        for stem, meta in source.get("subagent_files", {}).items():
            record = doc["subagents"].setdefault(
                stem, {"sources": [], "disposition": DISPOSITION_OPEN,
                       "first_observed": now})
            if source["name"] not in record["sources"]:
                record["sources"].append(source["name"])
            if not record.get("where"):
                record["where"] = f"{source['name']} :: {meta['path']}"
                record["bytes"] = meta["bytes"]
                record["sha256"] = meta["sha256"]
                record["recoverability"] = "byte_exact_recoverable"
            record["last_observed"] = now
    return doc


def parse_merge_stems(values: Sequence[str]) -> List[tuple]:
    """Parse repeated ``--merge-stems LABEL=PATH`` arguments.

    Inputs:
      values: raw argument strings.
    Outputs:
      list of (label, path).
    Raises:
      ValueError: an argument has no ``=``.
    Example:
      >>> parse_merge_stems(["a=/tmp/x"])
      [('a', '/tmp/x')]
    """
    out = []
    for raw in values or ():
        if "=" not in raw:
            raise ValueError(f"--merge-stems wants LABEL=PATH, got {raw!r}")
        label, path = raw.split("=", 1)
        out.append((label.strip(), path.strip()))
    return out


def main(argv: Optional[Sequence[str]] = None) -> int:
    """CLI entry point.

    Inputs:
      argv: argument vector.
    Outputs:
      int: 0 on success, 2 when nothing could be read.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="build the conversation census")
    parser.add_argument("--out", default=os.path.join(here, "conversation_census.json"))
    parser.add_argument("--archive", default=DEFAULT_ARCHIVE)
    parser.add_argument("--corpus-root", default=DEFAULT_CORPUS_ROOT)
    parser.add_argument("--state-dir", default=os.path.expanduser(
        "~/Library/Application Support/CloudeCode"))
    parser.add_argument("--nas", help="ssh destination for the NAS export tree")
    parser.add_argument("--roster", default=None,
                        help="subagent roster; defaults to beside --out")
    parser.add_argument("--merge-stems", action="append", metavar="LABEL=PATH",
                        help="merge a one-off stem listing from a source that "
                             "cannot be re-read on a routine refresh")
    args = parser.parse_args(argv)

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    roster_path = args.roster or default_roster_path(args.out)
    existing: dict = {}
    if os.path.exists(args.out):
        try:
            with open(args.out, "r", encoding="utf-8") as handle:
                existing = json.load(handle)
        except (OSError, ValueError) as exc:
            print(f"existing census unreadable, refusing to overwrite: {exc}",
                  file=sys.stderr)
            return 2

    sources: List[dict] = []
    problems: List[str] = []
    try:
        conv, sub, _rows = read_archive(args.archive)
        sources.append({"name": "live archive", "kind": "live database",
                        "location": args.archive,
                        "conversation_stems": sorted(conv),
                        "subagent_stems": sorted(sub)})
    except CannotEvaluate as exc:
        problems.append(str(exc))
    try:
        conv, sub, _where = read_corpus(args.corpus_root)
        sources.append({"name": "disk corpus", "kind": "filesystem",
                        "location": args.corpus_root,
                        "conversation_stems": sorted(conv),
                        "subagent_stems": sorted(sub)})
    except CannotEvaluate as exc:
        problems.append(str(exc))

    sources.extend(local_backup_stems(args.state_dir))

    if args.nas:
        for name, rel in NAS_DATABASES:
            try:
                sources.append(nas_database_stems(args.nas, name, rel))
            except CannotEvaluate as exc:
                problems.append(f"{name}: {exc}")
        for name, rel in NAS_MANIFESTS:
            try:
                sources.append(nas_manifest_stems(args.nas, name, rel))
            except CannotEvaluate as exc:
                problems.append(f"{name}: {exc}")

    if not sources:
        print("nothing could be read; census not written", file=sys.stderr)
        for line in problems:
            print(f"  {line}", file=sys.stderr)
        return 2

    doc = merge(existing, sources, now)

    # ONE-OFF LISTINGS FROM SOURCES THAT CANNOT BE RE-READ. Their digests are
    # carried forward across refreshes so a run without --merge-stems does not
    # quietly lose the fact that they were enumerated.
    contributing = dict((existing.get("roster") or {}).get(
        "contributing_sources", {}))
    merged_stems: Set[str] = set()
    try:
        for label, path in parse_merge_stems(args.merge_stems):
            try:
                lines = read_stem_file(path)
            except CannotEvaluate as exc:
                problems.append(f"{label}: {exc}")
                continue
            stems = subagent_stems_from_paths(lines)
            merged_stems |= stems
            contributing[label] = {"subagents": len(stems),
                                   "subagent_set_sha256": set_digest(stems),
                                   "merged_at": now, "from": path}
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    observed_subagents: Set[str] = set(merged_stems)
    for source in sources:
        observed_subagents.update(source.get("subagent_stems", []))
        contributing[source["name"]] = {
            "subagents": len(source.get("subagent_stems", [])),
            "subagent_set_sha256": set_digest(source.get("subagent_stems", [])),
            "merged_at": now, "from": source.get("location"),
        }
    roster_stats = write_roster(roster_path, observed_subagents)

    archived_subagents: Set[str] = set()
    try:
        _c, archived_subagents, _r = read_archive(args.archive)
    except CannotEvaluate:
        archived_subagents = set()
    # THE PROVENANCE MAP KEEPS ONLY WHAT IS MISSING. Identity for all ~19,000
    # lives in the roster; a run the archive already holds needs no recovery
    # pointer to be safe. An UNREADABLE archive leaves this set empty and
    # therefore prunes nothing, which is the fail-safe direction.
    doc["subagents"] = {k: v for k, v in doc["subagents"].items()
                        if k not in archived_subagents}
    doc["measured_once"] = [dict(entry) for entry in MEASURED_ONCE]
    doc["exclusions"] = build_exclusions(existing.get("exclusions"))
    doc["roster"] = {
        "path": os.path.basename(roster_path),
        "subagents": roster_stats["after"],
        "sha256": roster_stats["sha256"],
        "added_this_run": roster_stats["added"],
        "contributing_sources": contributing,
        "note": ("identity only, append only. provenance for a MISSING run is "
                 "in this file's 'subagents' map."),
    }
    doc["unreachable_at_build"] = problems
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(doc, handle, indent=1, sort_keys=True)
    print(f"census written to {args.out}")
    print(f"  sources recorded : {len(doc['sources'])}")
    print(f"  conversations    : {len(doc['conversations'])}")
    print(f"  roster subagents : {roster_stats['after']} "
          f"(+{roster_stats['added']} this run, "
          f"{roster_stats['would_have_dropped']} held that this run did not see)")
    print(f"  exclusions       : {len(doc['exclusions'])}")
    if problems:
        print(f"  UNREACHABLE      : {len(problems)}")
        for line in problems:
            print(f"    {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
