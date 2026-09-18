#!/usr/bin/env python3
"""Answer "when was my history last backed up, and did it verify?"

Description: one command, one screen, two questions that are NOT the same
  question and are reported separately because they fail separately:

    WAS A BACKUP TAKEN?   The artifact itself is the evidence. backup-m4.sh
      writes the dump through a .new-then-rename, so the file's mtime is the
      instant a dump last PASSED its checks - a failed dump leaves yesterday's
      file untouched and therefore visibly stale. Nothing has to be trusted to
      write a status line saying it succeeded.

    WAS A RESTORE PROVED? The record prove_restore.py leaves behind. A backup
      that has been taken and never restored is a hope, so these two never
      collapse into one green light.

  Freshness uses the four-value vocabulary this codebase already uses for the
  corpus ingester and the integrity checker - ``current`` / ``stale`` /
  ``never_ran`` / ``cannot_determine`` - reused rather than re-invented. The
  AGE is the signal: a job that died looks exactly like one that had nothing
  to do.

  ``--remote`` also asks the restic repository what it actually holds. That is
  a separate question from what this Mac believes it wrote, and the two
  disagreeing is exactly the failure this design exists to catch.
Inputs: command line - ``--json``, ``--remote``.
Output: human or JSON status on stdout. Exit 0 when both the backup is
  current and the last restore proof verified, 1 when something is wrong,
  2 when it could not be determined.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import history_backup_paths as P  # noqa: E402

CURRENT = "current"
STALE = "stale"
NEVER_RAN = "never_ran"
CANNOT_DETERMINE = "cannot_determine"

#: A nightly dump older than this is stale. Two days is one missed run plus
#: slack, matching the backup's own daily cadence.
BACKUP_WINDOW_SECONDS = 2 * 24 * 60 * 60

#: A weekly proof older than this is stale. Two weeks, same reasoning.
PROOF_WINDOW_SECONDS = 14 * 24 * 60 * 60


def _freshness(age: float, window: int) -> str:
    """Judge an age against a window.

    Inputs: age (float seconds), window (int seconds).
    Output: str, ``current`` or ``stale``.
    """
    return CURRENT if age <= window else STALE


def backup_state() -> Dict[str, object]:
    """Report on the artifact the nightly job produces.

    Description: opens the dump and counts it, rather than believing a
      filename. An unplugged drive is ``cannot_determine``, not a failure:
      nothing has been found wrong with anything.
    Inputs: none. Output: dict.
    """
    if not P.usb_available():
        return {"freshness": CANNOT_DETERMINE,
                "detail": f"{P.USB_VOLUME} is not mounted"}
    if not P.ARCHIVE_DUMP.is_file():
        return {"freshness": NEVER_RAN,
                "detail": f"{P.ARCHIVE_DUMP} does not exist"}
    try:
        stat = P.ARCHIVE_DUMP.stat()
    except OSError as exc:
        return {"freshness": CANNOT_DETERMINE, "detail": str(exc)}

    age = time.time() - stat.st_mtime
    out: Dict[str, object] = {
        "artifact": str(P.ARCHIVE_DUMP),
        "bytes": stat.st_size,
        "taken_at": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                  time.gmtime(stat.st_mtime)),
        "age_seconds": int(age),
        "freshness": _freshness(age, BACKUP_WINDOW_SECONDS),
    }
    try:
        from snapshot import read_only_connect
        conn = read_only_connect(P.ARCHIVE_DUMP)
        try:
            out["transcript_archives"] = conn.execute(
                "SELECT count(*) FROM transcript_archives").fetchone()[0]
            out["transcript_records"] = conn.execute(
                "SELECT count(*) FROM transcript_records").fetchone()[0]
        finally:
            conn.close()
        out["opens"] = True
    except Exception as exc:  # reported, never fatal - this is a status read
        out["opens"] = False
        out["open_failure"] = f"{type(exc).__name__}: {exc}"
    return out


def proof_state() -> Dict[str, object]:
    """Report on the last restore proof.

    Inputs: none. Output: dict.
    """
    record = P.STATE_DIR / "restore-proof.json"
    if not record.exists():
        return {"freshness": NEVER_RAN,
                "detail": "no restore has ever been proved"}
    try:
        payload = json.loads(record.read_text())
        age = time.time() - record.stat().st_mtime
    except (OSError, json.JSONDecodeError) as exc:
        return {"freshness": CANNOT_DETERMINE,
                "detail": f"{type(exc).__name__}: {exc}"}
    reconstructed = [
        {
            "source_path": item.get("source_path"),
            "bytes": item.get("restored_bytes"),
            "matches_live_file": item.get("matches_live_file"),
        }
        for item in ((payload.get("reconstruction") or {}).get(
            "archive_blob_restores") or [])
    ]
    return {
        "freshness": _freshness(age, PROOF_WINDOW_SECONDS),
        "age_seconds": int(age),
        "proved_at": payload.get("stamp"),
        "outcome": payload.get("outcome"),
        "detail": payload.get("detail"),
        "restored_sha256": (payload.get("interrogation") or {}).get(
            "restored_sha256"),
        "row_counts": (payload.get("interrogation") or {}).get("row_counts"),
        "conversations_reconstructed": reconstructed,
    }


def repository_state() -> Dict[str, object]:
    """Ask the restic repository what it is actually holding.

    Inputs: none. Output: dict; ``status`` is ``ran`` or ``cannot_determine``.
    """
    env = dict(os.environ)
    env["RESTIC_PASSWORD_FILE"] = str(P.RESTIC_PWFILE)
    try:
        proc = subprocess.run(
            [P.RESTIC_BIN, "-r", P.RESTIC_REPO, "snapshots", "--json",
             "--path", str(P.DUMP_DIR)],
            env=env, capture_output=True, text=True, timeout=180)
    except (subprocess.SubprocessError, OSError) as exc:
        return {"status": CANNOT_DETERMINE, "detail": str(exc)}
    if proc.returncode != 0:
        return {"status": CANNOT_DETERMINE,
                "detail": proc.stderr.strip()[-400:]}
    try:
        snaps: List[Dict[str, object]] = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"status": CANNOT_DETERMINE, "detail": proc.stdout[-400:]}
    newest = max(snaps, key=lambda s: str(s.get("time", "")), default=None)
    return {"status": "ran", "repository": P.RESTIC_REPO,
            "snapshots_holding_the_archive": len(snaps),
            "newest_snapshot_id": (newest or {}).get("short_id"),
            "newest_snapshot_time": (newest or {}).get("time")}


def offbox_state(backup: Dict[str, object],
                 repo: Dict[str, object]) -> Dict[str, object]:
    """Did the dump that exists locally actually REACH the repository?

    THIS EXISTS BECAUSE ITS ABSENCE PRODUCED A FALSE GREEN, MEASURED IN
      PRODUCTION. On 2026-09-18 the nightly job wrote a perfect 16.7 GB dump
      at 03:36:41 and then its ``restic backup`` hung: the TCP socket to the
      REST server stayed ESTABLISHED while the server had long since moved
      on, so the client sat at 0.0% CPU for over twelve hours holding a
      repository lock. The dump's mtime was fresh, so this command reported
      "freshness: current" and exited 0 while the day's history had not left
      the machine. Both facts were already on the screen - a local artifact
      from today and a newest repository snapshot from YESTERDAY - and
      nothing compared them. A status command whose two halves can disagree
      in silence is a proxy, not a measurement.

    The rule: the repository's newest snapshot covering the dump directory
      must be NEWER than the dump file itself. The job writes the dump and
      only then uploads it, so on any healthy day the snapshot is minutes
      newer. A snapshot older than the artifact means the artifact never
      shipped, whatever else looks fine.
    Inputs: backup (dict from backup_state), repo (dict from
      repository_state).
    Output: dict with ``status`` and, when decidable, ``shipped`` (bool).
    """
    if repo.get("status") != "ran":
        return {"status": CANNOT_DETERMINE,
                "detail": "the repository could not be queried"}
    if "taken_at" not in backup:
        return {"status": CANNOT_DETERMINE,
                "detail": "there is no local artifact to compare against"}
    raw = repo.get("newest_snapshot_time")
    if not raw:
        return {"status": "ran", "shipped": False,
                "detail": "the repository holds no snapshot of the dump "
                          "directory at all"}
    try:
        # restic emits RFC3339 with an offset. fromisoformat handles that
        # directly; anything it refuses is reported rather than guessed at.
        # A naive result is forced to UTC so the comparison below can never
        # raise "offset-naive and offset-aware" - which it did on the first
        # attempt, from a hand-rolled fraction trim that ate the offset.
        snap_at = _dt.datetime.fromisoformat(str(raw))
        if snap_at.tzinfo is None:
            snap_at = snap_at.replace(tzinfo=_dt.timezone.utc)
        taken_at = _dt.datetime.strptime(
            str(backup["taken_at"]), "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=_dt.timezone.utc)
    except (ValueError, TypeError) as exc:
        return {"status": CANNOT_DETERMINE,
                "detail": f"could not compare the two instants: {exc}"}

    shipped = snap_at >= taken_at
    lag = (taken_at - snap_at).total_seconds()
    return {
        "status": "ran",
        "shipped": shipped,
        "local_artifact_at": str(backup["taken_at"]),
        "repository_newest_at": str(raw),
        "detail": ("the local dump is in the repository"
                   if shipped else
                   f"the local dump is {int(lag) // 3600}h NEWER than "
                   f"anything in the repository, so it has not shipped"),
    }


def main() -> int:
    """Command line entry point.

    Inputs: argv. Output: int exit code.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--remote", action="store_true",
                        help="also ask the restic repository what it holds")
    args = parser.parse_args()

    backup = backup_state()
    proof = proof_state()
    report: Dict[str, object] = {"backup": backup, "restore_proof": proof}
    if args.remote:
        report["repository"] = repository_state()
        report["offbox"] = offbox_state(backup, report["repository"])

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print("CloudeCode history backup")
        print("")
        print("  BACKUP TAKEN")
        print(f"    when         : {backup.get('taken_at', 'never')}"
              + (f"  ({backup['age_seconds'] // 3600}h ago)"
                 if "age_seconds" in backup else ""))
        print(f"    freshness    : {backup.get('freshness')}")
        if backup.get("bytes"):
            print(f"    artifact     : {backup['bytes']} bytes, opens="
                  f"{backup.get('opens')}")
        if backup.get("transcript_archives") is not None:
            print(f"    history held : {backup['transcript_archives']} "
                  f"transcript archives, "
                  f"{backup.get('transcript_records')} records")
        if backup.get("detail"):
            print(f"    detail       : {backup['detail']}")
        print("")
        print("  RESTORE PROVED")
        print(f"    when         : {proof.get('proved_at', 'never')}"
              + (f"  ({proof['age_seconds'] // 3600}h ago)"
                 if "age_seconds" in proof else ""))
        print(f"    freshness    : {proof.get('freshness')}")
        print(f"    outcome      : {proof.get('outcome', 'unknown')}")
        for item in (proof.get("conversations_reconstructed") or []):
            print(f"      reconstructed {item.get('source_path')} "
                  f"({item.get('bytes')} B), matches the live file: "
                  f"{item.get('matches_live_file')}")
        if proof.get("detail"):
            print(f"    detail       : {proof['detail']}")
        if args.remote:
            off = report["offbox"]
            print("")
            print("  SHIPPED OFF-BOX")
            print(f"    local dump   : {off.get('local_artifact_at', '?')}")
            print(f"    repo newest  : {off.get('repository_newest_at', '?')}")
            print(f"    shipped      : {off.get('shipped')}")
            print(f"    detail       : {off.get('detail')}")
            print("")
            print(f"  REPOSITORY   : "
                  f"{json.dumps(report['repository'], sort_keys=True)}")

    off = report.get("offbox") or {}
    if off.get("status") == CANNOT_DETERMINE:
        return 2
    if CANNOT_DETERMINE in (backup.get("freshness"), proof.get("freshness")):
        return 2
    # A local artifact that never reached the repository is NOT a backup.
    if args.remote and off.get("shipped") is False:
        return 1
    if backup.get("freshness") != CURRENT or not backup.get("opens"):
        return 1
    if proof.get("freshness") != CURRENT or proof.get("outcome") != "verified":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
