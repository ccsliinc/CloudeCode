#!/usr/bin/env python3
"""Reconstruct real conversations out of a backup and judge whether they match.

THIS IS THE STEP EVERYBODY SKIPS AND IT IS THE ONLY ONE THAT PROVES THE
BACKUP IS WORTH ANYTHING. A file that hashed correctly and opened is a file;
a conversation that comes back out of it byte for byte is a backup.

Two independent reconstructions are attempted for every target, because they
fail in different ways:

  1. THE ARCHIVE BLOB. ``transcript_archives.content_gzip`` holds the
     original jsonl file's bytes. Note the column name is a lie: the blob is
     a raw ZLIB stream, not gzip, which is why this file calls the app's own
     ``export_archive`` rather than decompressing by hand. Hash the result
     and compare against BOTH the hash stored in the same row and the hash
     of the LIVE file on this Mac, measured independently. Comparing only
     against the row's own hash would be one fact agreeing with itself,
     which is how a verification step that cannot fail gets shipped.
  2. THE MESSAGE MODEL. ``src/core/message_model_export.export_transcript``
     re-renders the same conversation line by line out of the normalised v16
     tables and hashes the result. This proves the derived model still
     produces the original bytes, which is the thing the model exists to
     claim. Reported separately and does NOT gate the verdict, because the
     message model covers a subset of the corpus by design.

Run it two ways. As a library, ``pick_targets`` chooses what to reconstruct
and measures the live files. As a command, it reads a request on stdin and
prints a verdict, which is what lets the same code judge a restored copy
without the caller having to trust an in-process result.
Inputs: stdin - JSON ``{"db": path, "targets": [...], "export_targets": [...]}``.
Output: stdout - one JSON verdict. Exit 0 when every archive-blob target
  reconstructed byte-exact, 1 otherwise.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import sqlite3
import sys
from pathlib import Path
from typing import Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

#: How many conversations are pulled back. Three, chosen by SHAPE rather than
#: at random alone: the largest row exercises the multi-megabyte blob path, an
#: ordinary small one exercises the common case, and a random one keeps the
#: proof from silently becoming evidence about the same two rows for ever.
RESTORE_TARGET_COUNT: int = 3

CHUNK = 1 << 22


def _sha256_file(path: Path) -> str:
    """Hash a file's bytes.

    Inputs: path (Path). Output: str, lowercase hex sha256.
    """
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _connect(path: str) -> sqlite3.Connection:
    """Open a database for reading only, with the WAL shm fallback.

    Description: ``mode=ro`` cannot create the ``-shm`` a WAL database needs,
      so a fully checkpointed database with no sidecars refuses read-only
      connections outright. See snapshot.read_only_connect for the full
      account; this is the same ladder, duplicated deliberately so that this
      file stays runnable on its own against any copy of the archive.
    Inputs: path (str). Output: sqlite3.Connection.
    """
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=120.0)
        conn.execute("PRAGMA query_only = 1")
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except sqlite3.OperationalError:
        conn = sqlite3.connect(path, timeout=120.0)
        conn.execute("PRAGMA query_only = 1")
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
    # ROW FACTORY IS NOT COSMETIC HERE. The app's own readers are documented
    # as taking a connection with ``row_factory = sqlite3.Row``, and
    # export_archive indexes its rows BY COLUMN NAME. Handing it a plain
    # connection fails with "tuple indices must be integers or slices, not
    # str" - which reads like a bug in the archive rather than in the caller,
    # and cost this proof a run. sqlite3.Row still supports index access and
    # tuple unpacking, so every other query in this file is unaffected.
    conn.row_factory = sqlite3.Row
    return conn


def _corpus_dir() -> Path:
    """Resolved path of the live jsonl corpus.

    Description: ``~/.claude`` is a SYMLINK into iCloud, so the literal
      directory is elsewhere. Only the resolved spelling is used.
    Inputs: none. Output: Path.
    """
    return Path(os.path.realpath(os.path.expanduser("~/.claude/projects")))


def pick_targets(database: Path) -> List[Dict[str, object]]:
    """Choose conversations to reconstruct, and measure them on this Mac.

    Description: candidates are read out of the DATABASE BEING PROVED, so the
      target is certainly present in it, and then the corresponding LIVE file
      in the corpus is hashed to get an INDEPENDENT expected value. A target
      whose live file is absent is still usable - the row's own hash still
      proves the blob decompresses to what was ingested - but it is marked,
      so the report never overstates what was compared.
    Inputs: database (Path).
    Output: list of target dicts.
    """
    conn = _connect(str(database))
    corpus = _corpus_dir()
    try:
        # PREFER TARGETS WHOSE LIVE FILE IS STILL ON THIS MAC. The row's own
        # content_sha256 proves the blob decompresses to what was ingested,
        # but that is the backup agreeing with itself. The comparison worth
        # having is against the live jsonl, and only a target that still
        # exists on disk can take it. The archive is a SUPERSET of the live
        # tree - it holds imported conversations from /mnt/ARCHIVE and
        # transcripts the tree has since lost - so picking purely by size
        # lands on an unverifiable target most of the time.
        def live_ok(source_path: str) -> bool:
            return (corpus / source_path).is_file()

        def first_live(sql: str, limit: int = 400) -> List[tuple]:
            """First candidate from this query whose live file exists."""
            for row in conn.execute(sql + f" LIMIT {limit}"):
                if live_ok(row[1]):
                    return [tuple(row)]
            return []

        base = ("SELECT archive_uuid, source_path, content_sha256, "
                "       raw_byte_length FROM transcript_archives "
                "WHERE superseded_by_archive_id IS NULL "
                "  AND raw_byte_length > 0")
        rows = first_live(base + " ORDER BY raw_byte_length DESC")
        rows += first_live(base + " AND raw_byte_length BETWEEN 4096 AND 65536")
        pool = [tuple(r) for r in conn.execute(base + " ORDER BY id LIMIT 5000")
                if live_ok(r[1])]
    finally:
        conn.close()

    if pool:
        rows.append(random.choice(pool))
    seen: set = set()
    targets: List[Dict[str, object]] = []
    for uuid, source_path, sha, length in rows:
        if uuid in seen:
            continue
        seen.add(uuid)
        live = corpus / source_path
        targets.append({
            "archive_uuid": uuid,
            "source_path": source_path,
            "raw_bytes": length,
            "expected_row_sha256": sha,
            "expected_live_sha256": (
                _sha256_file(live) if live.is_file() else None),
            "live_file_present": live.is_file(),
        })
        if len(targets) >= RESTORE_TARGET_COUNT:
            break
    return targets


def pick_export_targets(database: Path) -> List[int]:
    """Choose message-model transcripts to re-render.

    Inputs: database (Path).
    Output: list of transcript ids, possibly empty when the model is not
      populated - which is reported, never guessed at.
    """
    conn = _connect(str(database))
    try:
        present = conn.execute(
            "SELECT count(*) FROM sqlite_master "
            "WHERE type='table' AND name='message_transcripts'"
        ).fetchone()[0]
        if not present:
            return []
        # SAMPLE FROM THE MIDDLE, AND SAMPLE SEVERAL. The newest transcripts
        # can still be mid-ingest and the oldest are from the model's own
        # bring-up; rows at either end hold appearances with neither a raw
        # line nor a renderable body, which is a property of those rows and
        # not of the backup. Five from the middle gives the report something
        # to be about either way.
        total = conn.execute(
            "SELECT count(*) FROM message_transcripts").fetchone()[0]
        return [row[0] for row in conn.execute(
            "SELECT id FROM message_transcripts ORDER BY id LIMIT 5 OFFSET ?",
            (max(0, total // 2),))]
    except sqlite3.Error:
        return []
    finally:
        conn.close()


def restore_archive_blob(conn: sqlite3.Connection,
                         target: Dict[str, object]) -> Dict[str, object]:
    """Reconstruct one transcript file out of the backup and judge it.

    Inputs: conn (sqlite3.Connection), target (dict from pick_targets).
    Output: dict verdict with ``ok``.
    """
    uuid = str(target["archive_uuid"])
    out: Dict[str, object] = {
        "archive_uuid": uuid,
        "source_path": target.get("source_path"),
        "ok": False,
    }
    row = conn.execute(
        "SELECT id, content_sha256, raw_byte_length "
        "FROM transcript_archives WHERE archive_uuid = ?", (uuid,)
    ).fetchone()
    if row is None:
        out["failure"] = "no such archive_uuid in the restored database"
        return out
    archive_id, row_sha, row_len = row

    # USE THE APP'S OWN RECONSTRUCTION PATH, NOT A HAND-ROLLED ONE. Two
    # reasons, and the first one was found the hard way.
    #
    # THE COLUMN IS NAMED content_gzip AND IT IS NOT GZIP. It holds a raw
    # zlib stream (level 9), so a gzip.decompress of it fails with "Not a
    # gzipped file (b'x\\xda')" - 78 da being zlib's own header. Measured on
    # the first real run of this proof, which failed on all three targets for
    # that reason alone while the backup underneath was perfectly sound. A
    # proof that reports a false negative is only marginally better than one
    # that reports a false positive.
    #
    # AND A ROW'S BYTES ARE NOT NECESSARILY IN ITS OWN BLOB. Schema v15
    # prefix-dedupe replaces the content of a row whose bytes are a strict
    # byte-prefix of a later version with a sentinel and points
    # superseded_by_archive_id at the row that still holds them.
    # export_archive walks that chain and slices to the requested row's own
    # raw_byte_length. Re-implementing either of those here would be a second
    # definition of "what this database means", which is how two things that
    # agree today stop agreeing later.
    try:
        from src.core.transcript_archive import export_archive
        raw = export_archive(conn, int(archive_id))
    except Exception as exc:  # reported as a verdict, see the docstring
        out["failure"] = f"{type(exc).__name__}: {exc}"
        return out

    actual = hashlib.sha256(raw).hexdigest()
    out["restored_bytes"] = len(raw)
    out["restored_sha256"] = actual
    out["row_sha256"] = row_sha
    out["row_byte_length"] = row_len
    out["expected_live_sha256"] = target.get("expected_live_sha256")

    problems: List[str] = []
    if actual != row_sha:
        problems.append("restored bytes disagree with the row's own sha256")
    if len(raw) != row_len:
        problems.append(f"restored {len(raw)} bytes, row records {row_len}")
    live = target.get("expected_live_sha256")
    if live:
        out["matches_live_file"] = (actual == live)
        if actual != live:
            problems.append(
                "restored bytes disagree with the live file on this Mac")
    else:
        out["matches_live_file"] = None
    # A plausible transcript, not an empty one. Zero bytes hashes
    # consistently and would otherwise pass every comparison above.
    if len(raw) == 0:
        problems.append("restored zero bytes")
    out["problems"] = problems
    out["ok"] = not problems
    if out["ok"]:
        out["first_line_excerpt"] = (
            raw.split(b"\n", 1)[0][:160].decode("utf-8", "replace"))
    return out


def restore_message_model(conn: sqlite3.Connection,
                          transcript_id: int) -> Dict[str, object]:
    """Re-render one transcript out of the normalised model and judge it.

    Inputs: conn (sqlite3.Connection), transcript_id (int).
    Output: dict verdict. Never raises: this proof is reported, not gating.
    """
    out: Dict[str, object] = {"transcript_id": transcript_id, "ok": False}
    try:
        from src.core.message_model_export import export_transcript
        result = export_transcript(conn, transcript_id, strict=True)
        out["expected_sha256"] = result.expected_content_sha256
        out["actual_sha256"] = result.actual_content_sha256
        out["lines"] = len(result.lines)
        out["bytes"] = len(result.text.encode("utf-8"))
        out["ok"] = bool(result.verified)
    except Exception as exc:  # reported, never fatal - see the docstring
        out["failure"] = f"{type(exc).__name__}: {exc}"
    return out


def main() -> int:
    """Read the request from stdin, run both proofs, print the verdict.

    Inputs: stdin JSON. Output: int exit code.
    """
    request = json.load(sys.stdin)
    db = str(request["db"])
    conn = _connect(db)
    try:
        blobs = [restore_archive_blob(conn, t)
                 for t in request.get("targets", [])]
        exports = [restore_message_model(conn, int(t))
                   for t in request.get("export_targets", [])]
    finally:
        conn.close()

    verdict = {
        "database": db,
        "archive_blob_restores": blobs,
        "archive_blob_all_ok": bool(blobs) and all(b["ok"] for b in blobs),
        "message_model_restores": exports,
        "message_model_all_ok": bool(exports) and all(e["ok"] for e in exports),
    }
    json.dump(verdict, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if verdict["archive_blob_all_ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
