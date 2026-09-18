#!/usr/bin/env python3
"""Restore the history archive OUT of the restic repository and prove it works.

THIS IS THE HALF NOBODY HAS. Taking a backup is the easy part and every
tool on this machine already does it. What almost nothing does is go back to
the repository afterwards, pull the artifact out, open it, and show that a
real conversation comes back byte for byte. A backup nobody has restored is
a hope, and this file is the difference.

WHAT PRODUCES THE ARTIFACT IS NOT THIS FILE. ``backup-m4.sh`` in the
docker-management repo takes the consistent VACUUM INTO dump onto the USB
drive and hands it to the restic repository that already backs this machine
up nightly. Building a second backup system beside that one would have given
the owner two half-understood backups instead of one well-understood one. So
this file never writes a backup and never touches the repository's contents;
it only asks the repository to give the artifact back and then interrogates
what arrives.

THE FIVE QUESTIONS IT ANSWERS, EACH ONE ABLE TO FAIL ON ITS OWN.
  1. Does the repository still hold the artifact? ``restic snapshots``.
  2. Will it give it back? A real ``restic restore`` onto the USB drive.
  3. Is what came back the same bytes? sha256 against the dump that was
     handed over, which restic verifies independently through its own chunk
     hashes, so a match is two mechanisms agreeing rather than one.
  4. Is it a working database? integrity_check and row counts ON THE
     RESTORED COPY, never on the original.
  5. Does a real conversation come out of it? Reconstructed through
     restore_proof and hash-matched against the LIVE jsonl file on this Mac.
     That last comparison is the only one whose expected value does not come
     out of the backup itself.
Inputs: command line - ``--keep-restored`` to leave the restored copy in
  place for inspection.
Output: a verdict on stdout and a liveness record. Exit 0 only when a
  conversation reconstructed byte-exact out of the restored copy.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import history_backup_paths as P  # noqa: E402
import restore_proof  # noqa: E402
from snapshot import read_only_connect, sha256_file  # noqa: E402

REPO_ROOT: Path = Path(__file__).resolve().parents[2]

#: Tables counted on the restored copy and compared against the live dump.
COUNTED_TABLES = ("transcript_archives", "transcript_records",
                  "message_transcripts", "message_bodies")


def _restic(args: List[str], timeout: int = 7200) -> subprocess.CompletedProcess:
    """Run one restic command against the repository.

    Description: the password is never read into this process, printed or
      logged; restic is handed the PATH to it.
    Inputs: args (list of str after the binary), timeout (int seconds).
    Output: subprocess.CompletedProcess with text streams.
    """
    env = dict(os.environ)
    env["RESTIC_PASSWORD_FILE"] = str(P.RESTIC_PWFILE)
    return subprocess.run([P.RESTIC_BIN, "-r", P.RESTIC_REPO] + args,
                          env=env, capture_output=True, text=True,
                          timeout=timeout)


def newest_snapshot_holding_dump() -> Dict[str, object]:
    """Find the newest repository snapshot that covers the dump directory.

    Description: asks for snapshots whose paths include the dump directory
      rather than pattern matching on every snapshot, so a repository shared
      with other hosts cannot hand back somebody else's.
    Inputs: none.
    Output: dict with ``ok`` and, when found, ``id`` and ``time``.
    """
    proc = _restic(["snapshots", "--json", "--path", str(P.DUMP_DIR)],
                   timeout=300)
    if proc.returncode != 0:
        return {"ok": False,
                "failure": "restic snapshots failed",
                "stderr": proc.stderr.strip()[-800:]}
    try:
        snaps = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "failure": "restic returned no snapshot list"}
    if not snaps:
        return {"ok": False,
                "failure": f"no snapshot in the repository covers "
                           f"{P.DUMP_DIR}"}
    newest = max(snaps, key=lambda s: str(s.get("time", "")))
    return {"ok": True, "id": newest.get("short_id"),
            "long_id": newest.get("id"), "time": newest.get("time"),
            "snapshots_covering_dump": len(snaps)}


def restore(snapshot_id: str, target: Path) -> Dict[str, object]:
    """Pull just the archive dump out of the repository onto the USB drive.

    Inputs: snapshot_id (str), target (Path, a throwaway directory).
    Output: dict with ``ok`` and the restored path.
    """
    out: Dict[str, object] = {"ok": False, "snapshot_id": snapshot_id}
    free = shutil.disk_usage(P.USB_ROOT).free
    need = P.ARCHIVE_DUMP.stat().st_size + (4 * 1024 ** 3)
    out["usb_free_bytes"] = free
    if free < need:
        out["failure"] = (f"{free} free bytes on {P.USB_VOLUME}, the restore "
                          f"needs about {need}")
        return out

    if target.exists():
        target.replace(target.with_name(target.name + ".superseded"))
    target.mkdir(parents=True, exist_ok=True)

    started = time.time()
    proc = _restic(["restore", snapshot_id, "--target", str(target),
                    "--include", str(P.ARCHIVE_DUMP)])
    out["restore_seconds"] = round(time.time() - started, 1)
    out["exit_code"] = proc.returncode
    if proc.returncode != 0:
        out["failure"] = "restic restore failed"
        out["stderr"] = proc.stderr.strip()[-1500:]
        return out

    found = list(target.rglob(P.ARCHIVE_DUMP.name))
    if not found:
        out["failure"] = "the restore reported success and produced no file"
        return out
    out["restored_path"] = str(found[0])
    out["ok"] = True
    return out


def interrogate(restored: Path) -> Dict[str, object]:
    """Ask the RESTORED copy whether it is the same, and whether it works.

    Description: every measurement here is taken on the restored file, never
      on the dump it came from. The sha256 comparison is the one place the
      original is consulted, and it is a comparison of two independently
      computed digests rather than a claim.
    Inputs: restored (Path).
    Output: dict with ``ok`` and every measurement.
    """
    out: Dict[str, object] = {"ok": False}
    problems: List[str] = []

    out["restored_bytes"] = restored.stat().st_size
    out["source_bytes"] = P.ARCHIVE_DUMP.stat().st_size
    out["restored_sha256"] = sha256_file(restored)
    out["source_sha256"] = sha256_file(P.ARCHIVE_DUMP)
    if out["restored_sha256"] != out["source_sha256"]:
        problems.append("the restored artifact does not hash to the dump "
                        "that was handed to the repository")
    if out["restored_bytes"] != out["source_bytes"]:
        problems.append("the restored artifact is a different size")

    conn = read_only_connect(restored)
    try:
        out["integrity_check"] = conn.execute(
            "PRAGMA integrity_check").fetchone()[0]
        present = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        counts: Dict[str, int] = {}
        for table in COUNTED_TABLES:
            if table in present:
                counts[table] = conn.execute(
                    f"SELECT count(*) FROM {table}").fetchone()[0]  # noqa: S608
        out["row_counts"] = counts
        out["table_count"] = len(present)
    finally:
        conn.close()

    if out["integrity_check"] != "ok":
        problems.append(f"integrity_check on the restored copy said "
                        f"{out['integrity_check']!r}")
    if counts.get("transcript_archives", 0) < P.MIN_TRANSCRIPT_ARCHIVES:
        problems.append(
            f"the restored copy holds only "
            f"{counts.get('transcript_archives', 0)} transcript_archives rows")

    out["problems"] = problems
    out["ok"] = not problems
    return out


def reconstruct(restored: Path) -> Dict[str, object]:
    """Pull real conversations out of the restored copy and hash-match them.

    Description: runs restore_proof as a SUBPROCESS against the restored
      file. A separate process is not ceremony: it means the verdict this
      function returns was produced by code that could only see the restored
      database and the live corpus, with no state carried over from the
      restore that might make a failure look like a success.
    Inputs: restored (Path).
    Output: dict, restore_proof's own verdict.
    """
    targets = restore_proof.pick_targets(restored)
    exports = restore_proof.pick_export_targets(restored)
    request = {"db": str(restored), "targets": targets,
               "export_targets": exports}
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).resolve().parent /
                             "restore_proof.py")],
        input=json.dumps(request), capture_output=True, text=True,
        env={**os.environ, "PYTHONPATH": str(REPO_ROOT)}, timeout=3600)
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"archive_blob_all_ok": False,
                "failure": "the reconstruction produced no verdict",
                "stderr": proc.stderr.strip()[-1500:]}


def main() -> int:
    """Command line entry point.

    Inputs: argv. Output: int exit code.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep-restored", action="store_true",
                        help="leave the restored copy on the USB drive")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    P.ensure_dirs()
    verdict: Dict[str, object] = {"stamp": stamp,
                                  "repository": P.RESTIC_REPO}

    if not P.usb_available():
        verdict["outcome"] = "cannot_determine"
        verdict["detail"] = f"{P.USB_VOLUME} is not mounted"
    elif not P.ARCHIVE_DUMP.is_file():
        verdict["outcome"] = "cannot_determine"
        verdict["detail"] = (f"{P.ARCHIVE_DUMP} does not exist, so there is "
                             f"nothing to compare a restore against")
    else:
        found = newest_snapshot_holding_dump()
        verdict["snapshot"] = found
        if not found["ok"]:
            verdict["outcome"] = "failed"
            verdict["detail"] = str(found.get("failure"))
        else:
            target = P.RESTORE_PROOF_ROOT / stamp
            got = restore(str(found["id"]), target)
            verdict["restore"] = got
            if not got["ok"]:
                verdict["outcome"] = "failed"
                verdict["detail"] = str(got.get("failure"))
            else:
                restored = Path(str(got["restored_path"]))
                checks = interrogate(restored)
                verdict["interrogation"] = checks
                if not checks["ok"]:
                    verdict["outcome"] = "failed"
                    verdict["detail"] = "; ".join(checks["problems"])
                else:
                    proof = reconstruct(restored)
                    verdict["reconstruction"] = proof
                    if proof.get("archive_blob_all_ok"):
                        verdict["outcome"] = "verified"
                        verdict["detail"] = (
                            "restored out of the restic repository, hashes "
                            "match, opens, and a real conversation "
                            "reconstructed byte exact against the live file")
                    else:
                        verdict["outcome"] = "failed"
                        verdict["detail"] = (
                            "no conversation reconstructed byte exact out of "
                            "the restored copy")
                if not args.keep_restored:
                    # Never delete: move it aside so the USB drive does not
                    # accumulate 16 GB per proof, and the owner clears
                    # _expired when he chooses.
                    P.USB_EXPIRED.mkdir(parents=True, exist_ok=True)
                    try:
                        target.replace(P.USB_EXPIRED / f"restore-proof-{stamp}")
                        verdict["restored_copy_moved_to"] = str(
                            P.USB_EXPIRED / f"restore-proof-{stamp}")
                    except OSError as exc:
                        verdict["restored_copy_moved_to"] = f"could not move: {exc}"

    record_path = P.STATE_DIR / "restore-proof.json"
    P.STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = record_path.with_suffix(".json.new")
    with open(tmp, "w") as handle:
        handle.write(json.dumps(verdict, indent=2, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, record_path)

    if args.json:
        print(json.dumps(verdict, indent=2, sort_keys=True))
    else:
        print(f"restore proof {stamp}: {verdict.get('outcome')}")
        print(f"  {verdict.get('detail')}")
        inter = verdict.get("interrogation") or {}
        if inter:
            print(f"  restored {inter.get('restored_bytes')} bytes, sha256 "
                  f"{str(inter.get('restored_sha256'))[:16]}..., "
                  f"integrity_check {inter.get('integrity_check')}")
            print(f"  row counts: {inter.get('row_counts')}")
        for item in ((verdict.get("reconstruction") or {}).get(
                "archive_blob_restores") or []):
            print(f"  reconstructed {item.get('source_path')} "
                  f"({item.get('restored_bytes')} B) sha256 "
                  f"{str(item.get('restored_sha256'))[:16]}... matches the "
                  f"live file on this Mac: {item.get('matches_live_file')}")
    return 0 if verdict.get("outcome") == "verified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
