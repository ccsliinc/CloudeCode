#!/usr/bin/env python3
"""Build or refresh the conversation census ``verify_all_conversations.py`` reads.

WHY A FILE AND NOT A SCAN. The census records every conversation ever OBSERVED
in a source that is not always reachable: databases and tarballs on the NAS, and
local database backups that get rotated away. A checker that can only answer
when the NAS is up is a checker nobody runs, so the observation is made once,
written down, and committed.

IT IS APPEND-ONLY ON THE CONVERSATION SET, WHICH IS THE WHOLE POINT. A stem that
was observed in July and has since been deleted from every source still belongs
in the census, because the question is "did this conversation ever exist", and a
census that forgot it would make its loss invisible. So a refresh MERGES: it adds
newly observed stems and updates source metadata, and it never drops a stem it
already knows. ``--forget`` exists for a stem recorded in error and names what it
is dropping.

WHAT IT RECORDS PER CONVERSATION. Which sources held it, where to find the only
copy if the live archive lacks it, its size and sha256 where a manifest gave
them, and a ``disposition``: ``open`` (a gap that must be closed) or ``accepted``
(the owner decided to leave it outside the archive, with a reason). Only the
owner should move a stem to ``accepted``, and the verifier prints accepted
entries on every run so the decision stays visible.

SUBAGENT RUNS ARE COUNTED, NOT ENUMERATED, AND THAT IS A NAMED LIMIT. There are
about 19,000 of them against about 1,300 conversations, so enumerating them would
make this a 450 KB file that churns on every ingest. The census therefore holds
the subagent COUNT per source plus the stems of any subagent run known to be
missing from the live archive. Consequence, stated plainly: a subagent run that
vanishes from every source at once would not be detected by the census, only by
the live disk-versus-archive comparison. A conversation would be.

READ ONLY against every database. NAS refresh runs read-only queries over ssh
and copies nothing back but stem lists.

Usage:
  python3 build_conversation_census.py --out conversation_census.json
  python3 build_conversation_census.py --out ... --nas truenas_admin@10.0.1.237
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import sqlite3
import subprocess
import sys
import time
from typing import Dict, List, Optional, Sequence, Set, Tuple

from conversation_sources import (CannotEvaluate, read_archive, read_corpus,
                                  split_stems, stem_of)
from verify_all_conversations import (DEFAULT_ARCHIVE, DEFAULT_CORPUS_ROOT,
                                      DISPOSITION_OPEN)

#: Where the NAS export tree lives, used only when --nas is given.
NAS_ROOT = "/mnt/ARCHIVE/vault/85_cloud-exports/claude"

#: Offline databases on the NAS, as (source name, path relative to NAS_ROOT).
#: Each is read read-only with immutable=1, which IS correct for these because
#: nothing writes them; it is NOT correct for the live archive and is never used
#: there.
NAS_DATABASES: Tuple[Tuple[str, str], ...] = (
    ("nas cloude-archive-20260903", "cloude-db-20260903/cloude-archive-20260903.db"),
    ("nas cloude-app-20260903", "cloude-db-20260903/cloude-app-20260903.db"),
    ("nas cloude-db-20260911", "cloude-db-20260911/cloude-db-20260911.db"),
    ("nas multihost-20260830", "multihost-db-20260830/multihost.db"),
)

#: Tarball manifests on the NAS, as (source name, manifest path). Identity comes
#: from the manifest rather than from expanding a 2 GB tarball: the manifest
#: carries one line per member as ``sha256 <TAB> size <TAB> path``, which is
#: exactly the file stem, size and hash the census wants.
NAS_MANIFESTS: Tuple[Tuple[str, str], ...] = (
    ("nas tarball 01-laptop-projects", "claude-archive-20260830/manifests/01-files.sha256.tsv.gz"),
    ("nas tarball 02-mini-projects", "claude-archive-20260830/manifests/02-files.sha256.tsv.gz"),
    ("nas tarball 03-gogs-history-6d8879b", "claude-archive-20260830/manifests/03-files.sha256.tsv.gz"),
    ("nas tarball 04-mini-claude-backup-20260106", "claude-archive-20260830/manifests/04-files.sha256.tsv.gz"),
    ("nas tarball 05-desktop-backups", "claude-archive-20260830/manifests/05-files.sha256.tsv.gz"),
    ("nas tarball 06-misc-claude2-and-app-sessions", "claude-archive-20260830/manifests/06-files.sha256.tsv.gz"),
    ("nas tarball 07-icloud-conflict-preserve", "claude-archive-20260902/manifests/07-files.sha256.tsv.gz"),
)

#: Sources that CANNOT be re-read on a routine refresh because reading them
#: costs a 22 GB decompression or a 4.5 GB git checkout, and whose readings are
#: therefore RECORDED rather than re-derived. Each carries the date it was
#: measured, the command that measured it, and the verdict. A recorded reading
#: is weaker evidence than a fresh one and is labelled as such on every run, so
#: nobody mistakes it for something this build just checked.
MEASURED_ONCE: Tuple[dict, ...] = (
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
    {
        "name": "openai codex CLI sessions (OUT OF SCOPE)",
        "kind": "different tool, recorded reading",
        "location": os.path.expanduser("~/.codex/sessions"),
        "measured_at": "2026-09-17",
        "how": "count rollout-*.jsonl under ~/.codex/sessions",
        "conversations": 195,
        "subagents": 0,
        "conversations_missing_from_live": [],
        "note": ("195 conversations with OpenAI Codex CLI, 17 MB, dated "
                 "2026-03-12 to 2026-03-19, none of them in this archive and "
                 "none of them meant to be: this archive's scope is Claude Code "
                 "transcripts. recorded here so the number is never mistaken "
                 "for zero."),
    },
)

#: A ``.jsonl`` under one of these path fragments is NOT a conversation, however
#: it is named. Measured against the real manifests: MCP server logs, the CLI
#: prompt history file, a plugin test fixture and this app's own migration trail
#: all end in ``.jsonl`` and would otherwise be counted as lost conversations.
NON_CONVERSATION_FRAGMENTS: Tuple[str, ...] = (
    "/mcp-logs-", "/caches/claude-cli-nodejs/", "/plugins/",
    "/migration_trail.jsonl", "/history.jsonl",
)


def looks_like_conversation(path: str) -> bool:
    """True when a .jsonl path is a real Claude Code session transcript.

    Inputs:
      path: a path from a manifest or a filesystem walk.
    Outputs:
      bool: False for MCP logs, CLI history, fixtures and bookkeeping files.
    Example:
      >>> looks_like_conversation("projects/-Users-x/a.jsonl")
      True
      >>> looks_like_conversation("Backups/claude/dot-claude/history.jsonl")
      False
    """
    if not path.endswith(".jsonl"):
        return False
    lowered = "/" + path.lstrip("./")
    return not any(frag in lowered for frag in NON_CONVERSATION_FRAGMENTS)


def ssh_python(host: str, script: str) -> str:
    """Run a python3 snippet on a remote host and return its stdout.

    Inputs:
      host: ssh destination, e.g. ``truenas_admin@10.0.1.237``.
      script: python source to run remotely.
    Outputs:
      str: stdout.
    Raises:
      CannotEvaluate: ssh failed or python exited non-zero.
    """
    proc = subprocess.run(["ssh", "-o", "ConnectTimeout=20", host,
                           "python3 -c " + shlex.quote(script)],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise CannotEvaluate(f"{host}: {proc.stderr.strip()[:400]}")
    return proc.stdout


def nas_database_stems(host: str, name: str, rel: str) -> dict:
    """Read conversation and subagent stems out of one offline NAS database.

    Inputs:
      host: ssh destination.
      name: census source name.
      rel: path under NAS_ROOT.
    Outputs:
      dict: {name, kind, location, conversation_stems, subagent_count}.
    Raises:
      CannotEvaluate: the database could not be read.
    """
    script = f'''
import sqlite3, os, json
p = {json.dumps(os.path.join(NAS_ROOT, rel))}
c = sqlite3.connect("file://" + p + "?mode=ro&immutable=1", uri=True)
tabs = {{r[0] for r in c.execute("select name from sqlite_master where type=\\'table\\'")}}
paths = []
if "transcript_archives" in tabs:
    paths += [r[0] for r in c.execute("select source_path from transcript_archives")]
if "message_transcripts" in tabs:
    cols = {{r[1] for r in c.execute("pragma table_info(message_transcripts)")}}
    col = "source_path" if "source_path" in cols else "source_ref"
    paths += [r[0] for r in c.execute("select " + col + " from message_transcripts")]
if "sessions" in tabs:
    cols = {{r[1] for r in c.execute("pragma table_info(sessions)")}}
    if "source_file_path" in cols:
        paths += [r[0] for r in c.execute("select source_file_path from sessions")]
print(json.dumps(paths))
'''
    paths = json.loads(ssh_python(host, script))
    conv, sub = split_stems(stem_of(p) for p in paths if p)
    return {"name": name, "kind": "offline database",
            "location": f"{host}:{os.path.join(NAS_ROOT, rel)}",
            "conversation_stems": sorted(conv), "subagent_count": len(sub)}


def nas_manifest_stems(host: str, name: str, rel: str) -> dict:
    """Read conversation stems, sizes and hashes out of one tarball manifest.

    Inputs:
      host: ssh destination.
      name: census source name.
      rel: manifest path under NAS_ROOT.
    Outputs:
      dict: {name, kind, location, conversation_stems, files, subagent_count}
        where ``files`` maps stem to {path, bytes, sha256}.
    Raises:
      CannotEvaluate: the manifest could not be read.
    """
    script = f'''
import gzip, json
rows = []
with gzip.open({json.dumps(os.path.join(NAS_ROOT, rel))}, "rt", errors="replace") as h:
    for line in h:
        parts = line.rstrip("\\n").split("\\t")
        if len(parts) == 3 and parts[2].endswith(".jsonl"):
            rows.append(parts)
print(json.dumps(rows))
'''
    rows = json.loads(ssh_python(host, script))
    files: Dict[str, dict] = {}
    subagents = 0
    sub_files: Dict[str, dict] = {}
    for sha, size, path in rows:
        stem = stem_of(path)
        if stem.startswith("agent-"):
            subagents += 1
            sub_files.setdefault(stem, {"path": path, "bytes": int(size),
                                        "sha256": sha})
            continue
        if not looks_like_conversation(path):
            continue
        files.setdefault(stem, {"path": path, "bytes": int(size), "sha256": sha})
    return {"name": name, "kind": "offline tarball manifest",
            "location": f"{host}:{os.path.join(NAS_ROOT, rel)}",
            "conversation_stems": sorted(files), "files": files,
            "subagent_files": sub_files, "subagent_count": subagents}


def local_backup_stems(state_dir: str) -> List[dict]:
    """Read conversation stems from every rotated database in the state dir.

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
                    "subagent_count": len(sub)})
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
        "schema": 1,
        "generated_at": now,
        "definition": (
            "a conversation is one real Claude Code session transcript, "
            "identified by its .jsonl file stem. agent-*.jsonl subagent runs "
            "are counted separately and are not conversations."),
        "sources": [],
        "conversations": dict(existing.get("conversations", {})),
        "subagents": dict(existing.get("subagents", {})),
    }
    for source in sources:
        stems = source.get("conversation_stems", [])
        files = source.get("files", {})
        doc["sources"].append({
            "name": source["name"], "kind": source["kind"],
            "location": source.get("location"),
            "conversations": len(stems),
            "subagents": source.get("subagent_count"),
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
                stem, {"sources": [], "first_observed": now})
            if source["name"] not in record["sources"]:
                record["sources"].append(source["name"])
            if not record.get("where"):
                record["where"] = f"{source['name']} :: {meta['path']}"
                record["bytes"] = meta["bytes"]
                record["sha256"] = meta["sha256"]
            record["last_observed"] = now
    return doc


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
    args = parser.parse_args(argv)

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
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
                        "subagent_count": len(sub)})
    except CannotEvaluate as exc:
        problems.append(str(exc))
    try:
        conv, sub, _where = read_corpus(args.corpus_root)
        sources.append({"name": "disk corpus", "kind": "filesystem",
                        "location": args.corpus_root,
                        "conversation_stems": sorted(conv),
                        "subagent_count": len(sub)})
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
    archived_subagents: Set[str] = set()
    for source in sources:
        if source["name"] == "live archive":
            try:
                _c, archived_subagents, _r = read_archive(args.archive)
            except CannotEvaluate:
                archived_subagents = set()
    # THE CENSUS KEEPS ONLY THE SUBAGENT RUNS THAT ARE MISSING. Enumerating all
    # ~19,000 would be a 450 KB file rewritten on every ingest, and a run the
    # archive already holds needs no record to be safe. Named limit, stated in
    # the module docstring: a subagent run that vanishes from every source at
    # once is not detected by the census, only by the live disk comparison. A
    # conversation would be.
    doc["subagents"] = {k: v for k, v in doc["subagents"].items()
                        if k not in archived_subagents}
    doc["measured_once"] = [dict(entry) for entry in MEASURED_ONCE]
    doc["unreachable_at_build"] = problems
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(doc, handle, indent=1, sort_keys=True)
    print(f"census written to {args.out}")
    print(f"  sources recorded : {len(doc['sources'])}")
    print(f"  conversations    : {len(doc['conversations'])}")
    if problems:
        print(f"  UNREACHABLE      : {len(problems)}")
        for line in problems:
            print(f"    {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
