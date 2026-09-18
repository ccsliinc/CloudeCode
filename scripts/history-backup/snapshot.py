#!/usr/bin/env python3
"""Take a CONSISTENT snapshot of the live history databases and verify it.

THIS IS NOT WHAT RUNS NIGHTLY, AND THE DISTINCTION MATTERS. The production
  snapshot is taken by ``dump_cloudecode_archive`` in
  ``devices/mini-m4/backup-m4.sh`` (docker-management repo, 03:30 daily),
  which hands it to the restic repository that already backs this machine up.
  There is one production path, not two. This module is two other things:

    - The SHARED READERS. ``read_only_connect`` and ``sha256_file`` are
      imported by ``prove_restore``, ``restore_proof`` and ``status``, so the
      WAL/``-shm`` fallback documented below exists in exactly one place.
    - ``measure_corpus_coverage``, which is the standing defence of this
      backup's central decision: that protecting the archive protects the
      12 GB jsonl corpus, because the archive stores every file's bytes. That
      is a CLAIM, and it is re-measured rather than assumed.

  Its ``take()`` remains useful for an ad-hoc verified snapshot outside the
  nightly job. If you change how a snapshot is taken, change backup-m4.sh
  too, or the two will agree only by luck.

Description: the ingester writes to ``cloude-archive.db`` continuously, so a
  plain file copy captures a torn database: SQLite writes pages in an order
  that is only meaningful at a transaction boundary, and ``cp`` reads them
  over seconds. This module uses ``VACUUM INTO`` instead, which runs inside a
  single read transaction on the source and writes a fresh, defragmented,
  transactionally coherent database file. It was chosen over the ``.backup``
  API for two measured reasons: VACUUM INTO reclaims free pages (the artifact
  is smaller than the source, so both the transfer and the NAS are cheaper),
  and it completes in one pass rather than restarting its page loop whenever a
  writer commits, which on a database written to as often as this one is the
  difference between finishing and livelocking.

  The source is opened READ-ONLY (``mode=ro``). It is NEVER opened with
  ``immutable=1``: the ingester is writing, and telling SQLite a file that is
  changing cannot change produces a reading of a database that does not exist.
  That has already segfaulted a pass on this box.

  Nothing here is trusted because it exited zero. The artifact is opened,
  integrity-checked, counted against a floor, and hashed, and the corpus
  coverage claim this whole design rests on is RE-MEASURED every run.
Inputs: command line - ``--stamp`` (UTC stamp for this run).
Output: writes the staging artifacts and a MANIFEST.json beside them; prints
  the manifest path. Exit 0 on a verified snapshot, 1 on a refusal.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

import history_backup_paths as P  # noqa: E402

#: Tables whose row counts are recorded in the manifest and re-checked on the
#: destination. Chosen because each one is a different FAMILY of evidence:
#: the byte-exact archive, the derived message model, and the projection.
COUNTED_TABLES: Tuple[str, ...] = (
    "transcript_archives",
    "transcript_records",
    "message_transcripts",
    "message_bodies",
    "message_content_blocks",
    "message_appearances",
)

CHUNK = 1 << 22


def sha256_file(path: Path) -> str:
    """Hash a file's bytes.

    Inputs: path (Path). Output: str, lowercase hex sha256.
    Example: sha256_file(Path("a.db"))[:8] -> '3f2a91cc'
    """
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_only_connect(path: Path) -> sqlite3.Connection:
    """Open a database for reading only, never immutable.

    Description: ``mode=ro`` still takes SQLite's normal locks, so a
      concurrent writer is observed correctly. ``immutable=1`` would skip
      locking entirely and is FORBIDDEN against the live archive - it tells
      SQLite that a file which is genuinely changing cannot change, and on
      this box it has already segfaulted a pass and produced a phantom
      reading.

      THE FALLBACK IS NOT OPTIONAL AND IT COST A RUN TO FIND. A WAL database
      needs a ``-shm`` file to be read at all, and a connection opened
      ``mode=ro`` CANNOT CREATE ONE. So the moment the ingester checkpoints
      and the ``-wal`` / ``-shm`` pair disappears - a perfectly healthy,
      fully committed state - every read-only URI connection to the archive
      starts failing with SQLITE_CANTOPEN, and the failure reads exactly
      like a missing or unreadable file. Measured on the live archive
      2026-09-17, minutes after the identical call had succeeded. The
      fallback opens the file normally and immediately sets
      ``PRAGMA query_only = 1``, so this process still cannot write; what it
      gains is permission to create the shared-memory index SQLite needs in
      order to read. ``query_only`` is enforced by SQLite itself, not by
      this function remembering to behave.
    Inputs: path (Path). Output: sqlite3.Connection.
    Example: read_only_connect(ARCHIVE_DB).execute("select 1").fetchone()
    """
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=120.0)
        conn.execute("PRAGMA query_only = 1")
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
        return conn
    except sqlite3.OperationalError:
        conn = sqlite3.connect(str(path), timeout=120.0)
        conn.execute("PRAGMA query_only = 1")
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
        return conn


def normalise_artifact(path: Path) -> str:
    """Put the snapshot into rollback journal mode so it is one self-contained file.

    Description: VACUUM INTO can hand back a database still declaring WAL,
      and a WAL database is not one file - it is a file plus two sidecars
      that a backup transfer will not carry and that a reader cannot
      recreate read-only (see :func:`read_only_connect`). A backup artifact
      that refuses to open read-only at the destination is not a backup. So
      the artifact is switched to ``journal_mode = delete`` here, once,
      before it is hashed, which makes every later reader on either side of
      the wire able to open it with no write permission and no sidecars.
    Inputs: path (Path) - the freshly vacuumed artifact.
    Output: str, the journal mode the file now declares.
    """
    conn = sqlite3.connect(str(path), timeout=120.0)
    try:
        mode = conn.execute("PRAGMA journal_mode = delete").fetchone()[0]
    finally:
        conn.close()
    for sidecar in (Path(str(path) + "-wal"), Path(str(path) + "-shm")):
        if sidecar.exists():
            with open(sidecar, "wb"):
                pass
    return str(mode)


def snapshot_connect(source: Path) -> sqlite3.Connection:
    """Open the source for a VACUUM INTO, without disarming the statement.

    Description: ``PRAGMA query_only = 1`` BLOCKS ``VACUUM INTO``. SQLite
      classifies it as a write statement on the connection even though the
      only file it writes is the brand new destination, so a query-only
      handle fails with "attempt to write a readonly database" - measured,
      not guessed, on the first real run of this job. So the snapshot handle
      deliberately does not set that pragma, and safety comes from the two
      things that still hold: ``mode=ro`` when the URI form can open (the
      source file itself is then unwritable at the VFS layer), and the fact
      that the only statement this connection ever executes is the VACUUM
      INTO below. ``immutable=1`` remains forbidden.
    Inputs: source (Path). Output: sqlite3.Connection.
    """
    try:
        conn = sqlite3.connect(f"file:{source}?mode=ro", uri=True,
                               timeout=120.0)
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
        return conn
    except sqlite3.OperationalError:
        # The WAL -shm cannot be created read-only. See read_only_connect.
        return sqlite3.connect(str(source), timeout=120.0)


def vacuum_into(source: Path, destination: Path) -> float:
    """Write a consistent copy of ``source`` to ``destination``.

    Description: VACUUM INTO refuses an existing destination, which is a
      feature - it cannot silently half-overwrite a previous artifact. The
      caller is responsible for the destination not existing.
    Inputs: source (Path, live database), destination (Path, must not exist).
    Output: float, elapsed seconds.
    Raises: sqlite3.Error - propagates; a failed snapshot must be loud.
    """
    started = time.time()
    conn = snapshot_connect(source)
    try:
        conn.execute("VACUUM INTO ?", (str(destination),))
    finally:
        conn.close()
    return time.time() - started


def verify_artifact(path: Path, *, min_bytes: int,
                    min_rows: Optional[int]) -> Dict[str, object]:
    """Open a snapshot artifact and prove it is sound.

    Description: four independent checks, because any one of them alone has
      a way of passing over a bad file. ``integrity_check`` walks every page
      of every B-tree; ``foreign_key_check`` catches a copy that is
      structurally fine and referentially broken; the row counts catch a
      valid but EMPTY database, which is what a re-init looks like; the byte
      floor catches a truncated transfer.
    Inputs: path (Path), min_bytes (int), min_rows (Optional[int] - applied
      to transcript_archives, None to skip).
    Output: dict with ``ok`` plus every measurement taken.
    """
    result: Dict[str, object] = {"path": str(path), "ok": False}
    size = path.stat().st_size
    result["bytes"] = size
    conn = read_only_connect(path)
    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        result["integrity_check"] = integrity
        fk_rows = conn.execute("PRAGMA foreign_key_check").fetchall()
        result["foreign_key_violations"] = len(fk_rows)
        present = {
            row[0] for row in
            conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        counts: Dict[str, int] = {}
        for table in COUNTED_TABLES:
            if table in present:
                counts[table] = conn.execute(
                    f"SELECT count(*) FROM {table}"  # noqa: S608 - fixed list
                ).fetchone()[0]
        result["row_counts"] = counts
        result["table_count"] = len(present)
    finally:
        conn.close()

    reasons: List[str] = []
    if integrity != "ok":
        reasons.append(f"integrity_check said {integrity!r}")
    if result["foreign_key_violations"]:
        reasons.append(
            f"{result['foreign_key_violations']} foreign key violations")
    if size < min_bytes:
        reasons.append(f"{size} bytes is below the {min_bytes} floor")
    if min_rows is not None:
        got = counts.get("transcript_archives", 0)
        if got < min_rows:
            reasons.append(
                f"transcript_archives holds {got} rows, below {min_rows}")
    result["refusals"] = reasons
    result["ok"] = not reasons
    return result


def measure_corpus_coverage(snapshot: Path) -> Dict[str, object]:
    """Re-measure the claim that the archive contains the jsonl corpus.

    Description: this backup deliberately protects the DATABASE rather than
      a second copy of the 12 GB jsonl corpus, on the grounds that the
      archive holds every file's bytes gzipped with its sha256. That is a
      CLAIM, and a claim that is never re-measured is how a backup quietly
      stops covering what everybody believes it covers. So every run walks
      the live corpus and checks each file's CURRENT bytes against the
      snapshot's own ``transcript_archives`` rows. Files being appended to
      right now (the session taking the backup, most obviously) will not
      match, which is expected and reported as a count rather than treated
      as a failure - the run that follows picks them up.
    Inputs: snapshot (Path) - the artifact to measure against, so the number
      describes the ARTIFACT and not the live database beside it.
    Output: dict with live file count, covered count, and the uncovered
      paths (capped, so a pathological run cannot write a huge manifest).
    """
    if not P.CORPUS_DIR.is_dir():
        return {"status": "cannot_determine",
                "detail": f"{P.CORPUS_DIR} is not a directory"}
    conn = read_only_connect(snapshot)
    try:
        by_path: Dict[str, set] = {}
        for source_path, sha in conn.execute(
                "SELECT source_path, content_sha256 FROM transcript_archives"):
            by_path.setdefault(source_path, set()).add(sha)
    finally:
        conn.close()

    live = 0
    covered = 0
    uncovered: List[str] = []
    for root, _dirs, files in os.walk(P.CORPUS_DIR):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            live += 1
            full = Path(root) / name
            rel = str(full.relative_to(P.CORPUS_DIR))
            known = by_path.get(rel)
            if known and sha256_file(full) in known:
                covered += 1
            elif len(uncovered) < 50:
                uncovered.append(rel)
    return {
        "status": "ran",
        "live_jsonl_files": live,
        "covered_byte_exact": covered,
        "uncovered_count": live - covered,
        "uncovered_sample": uncovered,
        "archive_distinct_source_paths": len(by_path),
    }


def free_bytes(path: Path) -> int:
    """Free bytes on the filesystem holding ``path``.

    Inputs: path (Path). Output: int.
    """
    usage = shutil.disk_usage(path)
    return usage.free




def take(stamp: str) -> int:
    """Take, verify and manifest one snapshot. Returns a process exit code.

    Description: writes EVERY artifact to the USB drive. Nothing of database
      scale touches the boot volume - see the staging rule in
      history_backup_paths. Two preflights refuse before any work begins: the
      USB drive must be mounted and writable, and the boot volume must still
      have headroom, because a machine this close to full is not one to start
      long work on even when the work is elsewhere.
    Inputs: stamp (str) - UTC run stamp.
    Output: int exit code, 0 only when every artifact verified.
    """
    P.ensure_dirs()
    out_dir = P.snapshot_dir(stamp)
    manifest: Dict[str, object] = {
        "stamp": stamp,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "host": os.uname().nodename,
        "method": "sqlite VACUUM INTO from a read-only handle",
        "staged_on": str(out_dir),
        "artifacts": {},
    }

    if not P.usb_available():
        print(f"CRIT: {P.USB_VOLUME} is not mounted or not writable",
              file=sys.stderr)
        return 2
    if not P.ARCHIVE_DB.exists():
        print(f"CRIT: {P.ARCHIVE_DB} does not exist", file=sys.stderr)
        return 1

    boot_free = free_bytes(Path.home())
    manifest["boot_volume_free_bytes"] = boot_free
    if boot_free < P.BOOT_VOLUME_FLOOR_BYTES:
        print(f"CRIT: the boot volume has {boot_free} bytes free, under the "
              f"{P.BOOT_VOLUME_FLOOR_BYTES} floor", file=sys.stderr)
        return 1

    out_dir.mkdir(parents=True, exist_ok=True)
    source_bytes = P.ARCHIVE_DB.stat().st_size
    usb_free = free_bytes(P.USB_ROOT)
    need = source_bytes + P.FREE_SPACE_HEADROOM_BYTES
    manifest["source_archive_bytes"] = source_bytes
    manifest["usb_free_bytes_before"] = usb_free
    if usb_free < need:
        print(f"CRIT: {usb_free} free bytes on {P.USB_VOLUME}, need about "
              f"{need}", file=sys.stderr)
        return 1

    plan = [
        (P.ARCHIVE_DB, P.ARCHIVE_ARTIFACT, P.MIN_ARCHIVE_BYTES,
         P.MIN_TRANSCRIPT_ARCHIVES),
        (P.APP_DB, P.APP_ARTIFACT, 64 * 1024, None),
    ]
    ok = True
    for source, artifact_name, min_bytes, min_rows in plan:
        if not source.exists():
            manifest["artifacts"][artifact_name] = {
                "ok": False, "refusals": [f"{source} missing"]}
            ok = False
            continue
        dest = out_dir / artifact_name
        # VACUUM INTO refuses an existing target, and a zero byte file counts
        # as an existing empty database. Move any leftover aside rather than
        # deleting it: this job never deletes, and a previous artifact is
        # never destroyed by a run that is about to fail.
        if dest.exists():
            dest.replace(dest.with_name(dest.name + ".superseded"))
        elapsed = vacuum_into(source, dest)
        journal_mode = normalise_artifact(dest)
        checks = verify_artifact(dest, min_bytes=min_bytes, min_rows=min_rows)
        checks["journal_mode"] = journal_mode
        checks["vacuum_seconds"] = round(elapsed, 2)
        checks["source"] = str(source)
        checks["source_bytes"] = source.stat().st_size
        checks["sha256"] = sha256_file(dest)
        manifest["artifacts"][artifact_name] = checks
        if not checks["ok"]:
            ok = False

    if ok:
        manifest["corpus_coverage"] = measure_corpus_coverage(
            out_dir / P.ARCHIVE_ARTIFACT)
    else:
        manifest["corpus_coverage"] = {
            "status": "cannot_determine",
            "detail": "snapshot did not verify, coverage not measured",
        }

    manifest["finished_at"] = time.strftime(
        "%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest["ok"] = ok
    target = out_dir / P.MANIFEST_NAME
    tmp = target.with_suffix(".json.new")
    tmp.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, target)
    print(str(target))
    return 0 if ok else 1


def main() -> int:
    """Command line entry point.

    Inputs: argv. Output: int exit code.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stamp", required=True,
                        help="UTC run stamp, YYYYmmddTHHMMSSZ")
    args = parser.parse_args()
    return take(args.stamp)


if __name__ == "__main__":
    raise SystemExit(main())
