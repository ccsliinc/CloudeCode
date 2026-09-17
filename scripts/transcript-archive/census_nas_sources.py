#!/usr/bin/env python3
"""Read the offline sources on the NAS, and nothing else.

WHY THIS IS ITS OWN MODULE. ``build_conversation_census.py`` decides what the
census SAYS; this file only answers "what is on the NAS". They were one file
until the census grew full subagent enumeration, at which point the combined
file went past this project's 500 line guideline. Splitting on the seam that
already existed - remote reading versus local composition - is cheaper than
letting the builder sprawl, and it means an ssh reader can be exercised without
touching census merge logic.

EVERY READER RETURNS SUBAGENT STEMS NOW, NOT JUST A COUNT. That is the change
the owner asked for: "even subagent because the archive viewer is an in depth
detailed viewer." A count can say a source holds 18,414 subagent runs; only the
stems can say WHICH one is missing. The stems feed
:mod:`subagent_roster`, which stores them as identity alone so the census does
not churn. See that module for why.

READ ONLY, ALWAYS. Every query runs with ``mode=ro``; the NAS databases also
take ``immutable=1``, which IS correct for them because nothing writes them. It
is never used for the live archive, where an immutable open of a moving WAL
database has already produced a segfault and a phantom row count on this machine.
"""
from __future__ import annotations

import json
import os
import shlex
import subprocess
from typing import Dict, Tuple

from conversation_sources import CannotEvaluate, split_stems, stem_of

#: Where the NAS export tree lives.
NAS_ROOT = "/mnt/ARCHIVE/vault/85_cloud-exports/claude"

#: Offline databases on the NAS, as (source name, path relative to NAS_ROOT).
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
      dict: {name, kind, location, conversation_stems, subagent_stems}.
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
            "conversation_stems": sorted(conv),
            "subagent_stems": sorted(sub)}


def nas_manifest_stems(host: str, name: str, rel: str) -> dict:
    """Read conversation stems, sizes and hashes out of one tarball manifest.

    Inputs:
      host: ssh destination.
      name: census source name.
      rel: manifest path under NAS_ROOT.
    Outputs:
      dict: {name, kind, location, conversation_stems, files, subagent_stems,
        subagent_files} where ``files`` maps stem to {path, bytes, sha256}.
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
    sub_files: Dict[str, dict] = {}
    for sha, size, path in rows:
        stem = stem_of(path)
        if stem.startswith("agent-"):
            sub_files.setdefault(stem, {"path": path, "bytes": int(size),
                                        "sha256": sha})
            continue
        if not looks_like_conversation(path):
            continue
        files.setdefault(stem, {"path": path, "bytes": int(size), "sha256": sha})
    return {"name": name, "kind": "offline tarball manifest",
            "location": f"{host}:{os.path.join(NAS_ROOT, rel)}",
            "conversation_stems": sorted(files), "files": files,
            "subagent_stems": sorted(sub_files), "subagent_files": sub_files}
