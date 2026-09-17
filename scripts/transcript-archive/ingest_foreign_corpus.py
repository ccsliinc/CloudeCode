#!/usr/bin/env python3
"""Archive transcripts that did NOT come from ``~/.claude/projects``.

DRY RUN BY DEFAULT. ``--apply`` is what writes.

WHY THIS EXISTS. :func:`src.core.transcript_corpus_ingest.ingest_corpus`
walks ``~/.claude/projects`` and composes a CORPUS-RELATIVE
``source_path`` (``<slug>/<uuid>.jsonl``). The root is implicit, which is
fine while every row in the table shares it. It stops being fine the
moment a transcript arrives from somewhere else: a relative path would
then claim a Claude Code project directory the file never lived in, and
this archive has already paid for one class of wrong path (the
cwd-spelling split, gotcha 6). A recovered file whose recorded origin is
fiction misleads every later reader, including the reconciliation passes.

THE ENCODING IS A LEADING SLASH, AND IT NEEDS NO NEW COLUMN. Measured on
the live archive before the first such ingest, 0 of 24,577 rows began
with ``/``. So an absolute ``source_path`` is self-describing: it
declares its own root, and no reader can mistake it for one relative to
the corpus. ``transcript_archives.source_path`` is ``TEXT NOT NULL``
with no CHECK, and :func:`ingest_transcript_bytes` documents the column
as "informational provenance only, never authoritative for rooting", so
this is the column used as specified rather than stretched.

NOTHING IS HAND-WRITTEN INTO THE TABLES. This builds
:class:`CorpusEntry` values and calls :func:`ingest_one`, so the
``(source_path, content_sha256)`` idempotency key, prefix dedupe,
content-addressed dedupe and the per-line record index all still apply
exactly as they do for the real corpus.

WHAT IT COSTS, SAID PLAINLY. Two path-arithmetic helpers assume the
relative shape and therefore REFUSE an absolute path rather than
answering wrongly, which is the right failure but is still a gap:

* ``_derive_parent_source_path`` tests ``parts[2] == 'subagents'``, which
  an absolute path cannot satisfy, so structural subagent rooting does
  not fire. This script roots those rows explicitly through
  :func:`root_archive`, which takes the parent from its caller by
  design, keyed on the same fact the ingester would have used: the file
  sits in a ``subagents/`` directory under its session's uuid.
* ``transcript_restore_target.compose_target`` returns None for any
  source_path starting with ``/`` (``ESCAPES_CORPUS_ROOT``). That guard
  is CORRECT here - it stops a restore writing outside the corpus, and
  these files are genuinely not in it - but it does mean the restore
  script cannot place these rows on its own. Reconstruction
  (:func:`export_archive`) is unaffected, which is the half the
  byte-exactness promise rests on.

Usage::

    # build a manifest of every .jsonl under a recovered tree
    ingest_foreign_corpus.py --build-manifest \\
        --tree /path/to/recovered --origin-root "/original/abs/root" \\
        --manifest m.json

    # what would happen, and nothing else
    ingest_foreign_corpus.py --manifest m.json

    # write, then round-trip every row against the bytes on disk
    ingest_foreign_corpus.py --manifest m.json --apply
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Dict, List

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from src.core.db import transaction  # noqa: E402
from src.core.transcript_archive import export_archive, root_archive  # noqa: E402
from src.core.transcript_corpus_discover import CorpusEntry  # noqa: E402
from src.core.transcript_corpus_ingest import ingest_one  # noqa: E402

#: The live transcript archive. NEVER opened with ``immutable=1``: it is
#: written by a running ingester, and an immutable open of a live WAL
#: database has already produced a segfault and a phantom row count on
#: this machine.
DEFAULT_ARCHIVE_DB = os.path.expanduser(
    "~/Library/Application Support/CloudeCode/cloude-archive.db"
)

#: tmux-style long timeout. A concurrent ingest pass holding the write
#: lock is normal, not a failure, so waiting is correct and giving up
#: after the sqlite3 default of 5s would manufacture one.
BUSY_TIMEOUT_MS = 120_000

SUBAGENTS_DIRNAME = "subagents"


def connect(db_path: str) -> sqlite3.Connection:
    """Open the archive read-write with a long busy timeout.

    Description: the single connect used by every mode here, so no call
      site can forget the timeout or reach for ``immutable=1``.
    Inputs: db_path (str) - path to the archive database.
    Output: sqlite3.Connection with a Row factory.
    Example: conn = connect(DEFAULT_ARCHIVE_DB)
    """
    conn = sqlite3.connect(db_path, timeout=BUSY_TIMEOUT_MS / 1000)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    return conn


def classify_kind(relative_path: str) -> str:
    """Decide 'session' or 'subagent' from a file's location alone.

    Description: the same structural rule corpus discovery uses - a file
      whose parent directory is ``subagents`` is a subagent run, anything
      else is a top-level conversation. Location only, never content, so
      the answer cannot depend on parsing.
    Inputs: relative_path (str) - POSIX path relative to the tree root.
    Output: str - "subagent" or "session".
    Example: classify_kind("a/u/subagents/agent-x.jsonl")  # 'subagent'
    """
    parts = relative_path.split("/")
    return "subagent" if len(parts) >= 2 and parts[-2] == SUBAGENTS_DIRNAME else "session"


def build_manifest(tree: Path, origin_root: str) -> List[Dict]:
    """Hash every .jsonl under a recovered tree and name its true origin.

    Description: the manifest is taken from the bytes ON DISK NOW, before
      anything is written, so the post-ingest round trip compares against
      a reading rather than against an assumption. ``origin_root`` is
      joined to each file's path RELATIVE to ``tree``, which requires the
      recovered tree to be a faithful mirror of the original layout; that
      is a claim about the recovery, and the caller supplies it.
    Inputs: tree (Path) - root of the recovered files. origin_root (str) -
      the absolute directory the tree was recovered FROM, no trailing
      slash.
    Output: list of dicts, one per file, sorted by path.
    Example: build_manifest(Path('/rec'), '/orig')[0]['kind']  # 'session'
    """
    rows: List[Dict] = []
    for path in sorted(tree.rglob("*.jsonl")):
        data = path.read_bytes()
        rel = path.relative_to(tree).as_posix()
        rows.append(
            {
                "rel": rel,
                "abs_recovered": str(path),
                "source_path": f"{origin_root.rstrip('/')}/{rel}",
                "kind": classify_kind(rel),
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
            }
        )
    return rows


def counts(conn: sqlite3.Connection) -> Dict[str, int]:
    """Read the two counts an ingest pass has to account for.

    Inputs: conn (sqlite3.Connection).
    Output: dict with 'archives' and 'records'.
    Example: counts(conn)['archives']  # 24577
    """
    return {
        "archives": conn.execute(
            "SELECT COUNT(*) FROM transcript_archives"
        ).fetchone()[0],
        "records": conn.execute(
            "SELECT COUNT(*) FROM transcript_records"
        ).fetchone()[0],
    }


def parent_source_path(subagent_source_path: str) -> str:
    """Recover the parent session's path for an ABSOLUTE subagent path.

    Description: the same rule as
      ``transcript_corpus_ingest._derive_parent_source_path`` -
      ``<dir>/<session_uuid>/subagents/<file>.jsonl`` has parent
      ``<dir>/<session_uuid>.jsonl`` - expressed positionally from the
      END of the path, because that function's ``parts[2]`` test is
      anchored to the start and an absolute path can never satisfy it.
      Refuses rather than guessing when the shape does not match.
    Inputs: subagent_source_path (str) - absolute POSIX path.
    Output: str - the parent session's absolute source_path.
    Raises: ValueError - the path is not the expected subagent shape.
    Example: parent_source_path("/a/b/u/subagents/x.jsonl")  # '/a/b/u.jsonl'
    """
    path = Path(subagent_source_path)
    if path.parent.name != SUBAGENTS_DIRNAME:
        raise ValueError(f"not a subagent shape: {subagent_source_path!r}")
    return f"{path.parent.parent}.jsonl"


def run_ingest(conn: sqlite3.Connection, rows: List[Dict], decided_by: str) -> int:
    """Ingest every manifest row, root the subagents, verify the round trip.

    Description: three phases in one pass so a partial result cannot be
      reported as a whole one. Ingest goes through :func:`ingest_one`.
      Rooting is explicit, per the module docstring. Verification exports
      each new row and compares it to the bytes still on disk, which is
      the only evidence that makes the disk copies redundant.
    Inputs: conn (sqlite3.Connection). rows (list of manifest dicts).
      decided_by (str) - recorded verbatim in
      ``transcript_root_decisions.decided_by``.
    Output: int - process exit code, 0 only when every row round-tripped.
    """
    before = counts(conn)
    print(f"BEFORE  archives={before['archives']}  records={before['records']}")

    outcomes = {}
    for row in rows:
        entry = CorpusEntry(
            abs_path=Path(row["abs_recovered"]),
            source_path=row["source_path"],
            kind=row["kind"],
        )
        outcome = ingest_one(conn, entry)
        outcomes[row["source_path"]] = outcome
        print(f"{outcome.outcome:16} id={outcome.archive_id}"
              f" growth={outcome.growth_kind} {Path(row['source_path']).name}")
        if outcome.outcome == "could_not_read":
            print(f"  FAILED: {outcome.reason}")

    rooted = 0
    for row in rows:
        if row["kind"] != "subagent":
            continue
        child = outcomes[row["source_path"]]
        if child.archive_id is None:
            continue
        parent = conn.execute(
            "SELECT id FROM transcript_archives WHERE source_path = ?"
            " ORDER BY id DESC LIMIT 1",
            (parent_source_path(row["source_path"]),),
        ).fetchone()
        if parent is None:
            print(f"  no parent row for {row['source_path']} - left unrooted")
            continue
        with transaction(conn):
            root_archive(
                conn,
                child.archive_id,
                parent_archive_id=int(parent["id"]),
                decided_by=decided_by,
                note="parent fixed by the subagents/ directory the file sits in",
            )
        rooted += 1

    after = counts(conn)
    print(f"AFTER   archives={after['archives']}  records={after['records']}")
    print(f"DELTA   archives=+{after['archives'] - before['archives']}"
          f"  records=+{after['records'] - before['records']}"
          f"  subagents_rooted={rooted}")

    passed = 0
    for row in rows:
        outcome = outcomes[row["source_path"]]
        if outcome.archive_id is None:
            print(f"FAIL no archive id {row['source_path']}")
            continue
        data = export_archive(conn, outcome.archive_id)
        good = (
            hashlib.sha256(data).hexdigest() == row["sha256"]
            and len(data) == row["bytes"]
            and data == Path(row["abs_recovered"]).read_bytes()
        )
        passed += 1 if good else 0
        print(f"{'PASS' if good else 'FAIL'} id={outcome.archive_id}"
              f" bytes={len(data)}/{row['bytes']} {Path(row['source_path']).name}")
    print(f"ROUND TRIP: {passed}/{len(rows)} byte-identical to the source files")
    return 0 if passed == len(rows) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--build-manifest", action="store_true")
    parser.add_argument("--tree", type=Path, help="with --build-manifest")
    parser.add_argument("--origin-root", help="with --build-manifest")
    parser.add_argument("--db", default=DEFAULT_ARCHIVE_DB)
    parser.add_argument("--decided-by", default="ingest_foreign_corpus:structural")
    parser.add_argument("--apply", action="store_true", help="actually write")
    args = parser.parse_args()

    if args.build_manifest:
        if not args.tree or not args.origin_root:
            parser.error("--build-manifest needs --tree and --origin-root")
        rows = build_manifest(args.tree, args.origin_root)
        args.manifest.write_text(json.dumps(rows, indent=2))
        total = sum(r["bytes"] for r in rows)
        print(f"manifest: {args.manifest}  files={len(rows)}  bytes={total}")
        return 0

    rows = json.loads(args.manifest.read_text())
    conn = connect(args.db)
    try:
        if not args.apply:
            current = counts(conn)
            print(f"BEFORE  archives={current['archives']}"
                  f"  records={current['records']}")
            for row in rows:
                existing = conn.execute(
                    "SELECT id FROM transcript_archives WHERE source_path = ?",
                    (row["source_path"],),
                ).fetchone()
                print(f"WOULD INGEST kind={row['kind']:9} bytes={row['bytes']:>9}"
                      f" existing={existing['id'] if existing else None}"
                      f" {row['source_path']}")
            print("DRY RUN - nothing written. Pass --apply.")
            return 0
        return run_ingest(conn, rows, args.decided_by)
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
