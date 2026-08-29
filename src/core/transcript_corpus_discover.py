"""Corpus discovery and content hashing for transcript_corpus_ingest.py.

Description: split out of transcript_corpus_ingest.py purely to respect
  this project's 500-line file cap - see that module's docstring for the
  full design rationale (idempotency key, growing-file handling, decisive
  rooting). This file holds only the parts that never touch a database
  connection: walking the corpus directory tree by STRUCTURE (never
  content) into :class:`CorpusEntry` rows, and the streaming sha256/mtime
  helpers used to decide whether a file's content has changed.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

#: Read granularity for the pre-ingest hashing pass. Matches
#: transcript_archive.DEFAULT_STREAM_CHUNK_SIZE so the two passes over a
#: changed file cost the same order of magnitude of work.
HASH_CHUNK_SIZE = 4 * 1024 * 1024

#: The subdirectory name Claude Code always uses for subagent
#: transcripts - part of the structural rooting rule, not a guess.
SUBAGENTS_DIRNAME = "subagents"


@dataclass
class CorpusEntry:
    """One file discovered under the corpus root, not yet read.

    Description: the output of :func:`discover_corpus` - path plus the
      structural facts derivable from its LOCATION alone (never its
      content), which is exactly what the decisive rooting rules are
      allowed to use.
    Inputs: constructed only by :func:`discover_corpus`.
    Output: n/a (data holder).
    """

    abs_path: Path
    source_path: str  # corpus-relative, POSIX separators
    kind: str  # "session" | "subagent"


def default_corpus_root() -> Path:
    """Return the default Claude Code transcript corpus root.

    Description: single source of the default path so callers who want
      the real corpus and callers who want a scratch copy pass this
      exact same join everywhere.
    Inputs: none.
    Output: Path - ``~/.claude/projects``, expanded, not verified to
      exist.
    Example: default_corpus_root()  # Path('/Users/x/.claude/projects')
    """
    return Path.home() / ".claude" / "projects"


def discover_corpus(corpus_root: Path) -> List[CorpusEntry]:
    """Walk a corpus root and classify every ``*.jsonl`` by location alone.

    Description: two shapes only, both structural - a top-level file
      directly under a project-slug directory is ``kind="session"``; a
      file under ``<slug>/<uuid>/subagents/`` is ``kind="subagent"``.
      Anything else (a ``*.jsonl`` at an unrecognised depth) is skipped
      from discovery entirely, since this module has never seen such a
      shape in the real corpus and inventing a classification for an
      unknown shape would be exactly the kind of guess the rooting rules
      forbid.
    Inputs: corpus_root (Path) - typically :func:`default_corpus_root`
      or a local read-only copy of it.
    Output: list[CorpusEntry], sorted by source_path for deterministic
      run ordering (matters for resumability logs, not for correctness).
    Example: discover_corpus(Path("~/.claude/projects")) -> [...]
    """
    entries: List[CorpusEntry] = []
    corpus_root = Path(corpus_root)
    if not corpus_root.is_dir():
        return entries

    for slug_dir in sorted(p for p in corpus_root.iterdir() if p.is_dir()):
        slug = slug_dir.name
        for item in sorted(slug_dir.iterdir()):
            if item.is_file() and item.suffix == ".jsonl":
                entries.append(
                    CorpusEntry(
                        abs_path=item,
                        source_path=f"{slug}/{item.name}",
                        kind="session",
                    )
                )
            elif item.is_dir():
                sub = item / SUBAGENTS_DIRNAME
                if not sub.is_dir():
                    continue
                for sfile in sorted(sub.iterdir()):
                    if sfile.is_file() and sfile.suffix == ".jsonl":
                        entries.append(
                            CorpusEntry(
                                abs_path=sfile,
                                source_path=(
                                    f"{slug}/{item.name}/"
                                    f"{SUBAGENTS_DIRNAME}/{sfile.name}"
                                ),
                                kind="subagent",
                            )
                        )
    return entries


def hash_file(path: Path) -> tuple:
    """Stream-hash a file without holding it fully in memory.

    Description: the pre-ingest identity check - reads the file once in
      bounded chunks purely to compute sha256 and size, so the
      already-present decision can be made before the (separate,
      heavier) actual ingest read happens.
    Inputs: path (Path).
    Output: tuple[str, int] - (sha256 hex digest, byte length).
    Raises: OSError - the file could not be opened or read.
    Example: hash_file(Path("x.jsonl")) -> ("abc123...", 4096)
    """
    hasher = hashlib.sha256()
    size = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(HASH_CHUNK_SIZE)
            if not chunk:
                break
            hasher.update(chunk)
            size += len(chunk)
    return hasher.hexdigest(), size


def mtime_iso(path: Path) -> Optional[str]:
    """Read a file's mtime as UTC ISO-8601, or None if it cannot be stat'd.

    Description: provenance only (see transcript_archive.py's module
      docstring - ``ingest_source_mtime`` is never authoritative for
      anything this module decides), so a stat failure degrades to None
      rather than aborting the ingest.
    Inputs: path (Path).
    Output: str | None.
    """
    try:
        ts = os.stat(path).st_mtime
    except OSError:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.%fZ"
    )
