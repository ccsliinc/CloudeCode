"""Single source of truth for every path, name and threshold this backup uses.

Description: the backup job, the status reader, the rotation planner and the
  restore rehearsal all import from here, so a path can never be spelled two
  ways across the four of them. No magic strings anywhere else in this
  directory.

  THE STAGING RULE IS LOAD BEARING AND IT IS WRITTEN DOWN BECAUSE IT WAS
  GOT WRONG ONCE. Nothing of database scale is ever written to the boot
  volume. The Mac's boot volume runs at about 30 GiB free with a 15 GB live
  archive on it; a 15 GB VACUUM INTO landing beside it took the volume to 94
  percent full. Every artifact of that size goes to the USB drive at
  /Volumes/Backup, which has 3.9 TiB free. That drive is the OWNER'S, so
  this job works only inside its own clearly named subdirectory and touches
  nothing else on it.
Inputs: none (module-level constants).
Outputs: constants, plus small helpers that derive paths.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Final

# ---------------------------------------------------------------------------
# Sources on this Mac
# ---------------------------------------------------------------------------

#: CloudeCode's application-support directory.
APP_SUPPORT: Final[Path] = (
    Path.home() / "Library" / "Application Support" / "CloudeCode"
)

#: The history archive. About 15 GB, WAL mode, written continuously by the
#: corpus ingester. This is the irreplaceable one.
ARCHIVE_DB: Final[Path] = APP_SUPPORT / "cloude-archive.db"

#: The small application database (sessions, projects, groups). Schema v29.
APP_DB: Final[Path] = APP_SUPPORT / "cloude.db"

#: The raw jsonl corpus. NOTE the real path: ``~/.claude`` is a SYMLINK into
#: iCloud, so the literal directory is under Sync/Claude. Two spellings of one
#: directory is how this project has been bitten before; only the resolved
#: one is used here.
CORPUS_DIR: Final[Path] = Path(
    os.path.realpath(os.path.expanduser("~/.claude/projects"))
)

# ---------------------------------------------------------------------------
# The USB drive. EVERYTHING of size lives here and nowhere else.
# ---------------------------------------------------------------------------

#: The owner's external APFS volume, 4.5 TiB.
USB_VOLUME: Final[Path] = Path("/Volumes/Backup")

#: This job's own subdirectory on it. Nothing outside this path is written,
#: read for modification, moved or removed by anything in this directory.
USB_ROOT: Final[Path] = USB_VOLUME / "cloudecode-history-backup"

#: Where backup-m4.sh writes the nightly consistent dump. It holds ONE file
#: and nothing else, deliberately, so it can be named as a restic source
#: without dragging along restore rehearsals or expired copies.
DUMP_DIR: Final[Path] = USB_ROOT / "dump"
ARCHIVE_DUMP: Final[Path] = DUMP_DIR / "cloude-archive.online-backup.db"

#: Historic staging root from the superseded self-contained design. Kept only
#: so the expired artifacts under it remain addressable.
STAGING_ROOT: Final[Path] = USB_ROOT / "snapshots"

#: Where a restore rehearsal unpacks the repository's own copy.
RESTORE_PROOF_ROOT: Final[Path] = USB_ROOT / "restore-proof"

#: Where superseded local snapshots are MOVED. Nothing here deletes.
USB_EXPIRED: Final[Path] = USB_ROOT / "_expired"

# ---------------------------------------------------------------------------
# Local state. TEXT ONLY - a few kilobytes of JSON. This is the one thing
# that stays on the boot volume, because the status command has to be
# answerable when the USB drive is unplugged.
# ---------------------------------------------------------------------------

STATE_DIR: Final[Path] = APP_SUPPORT / "history-backup"
LATEST_JSON: Final[Path] = STATE_DIR / "latest.json"
RUNS_LOG: Final[Path] = STATE_DIR / "runs.jsonl"
RUN_LOG: Final[Path] = STATE_DIR / "last-run.log"

# ---------------------------------------------------------------------------
# The off-box carrier: the restic repository that ALREADY backs up this Mac.
# ---------------------------------------------------------------------------

#: rest server on qnap-home. Deduplicated and incremental, which is why this
#: job hands it an artifact rather than inventing a second full-copy
#: mechanism beside it. The repo is --append-only: backup succeeds, prune
#: returns 403. Retention therefore runs on the host that physically stores
#: the repo (restic-local-retention.sh, 05:00 on qnap-home, 7d/4w/6m) and is
#: NOT this job's business.
RESTIC_REPO: Final[str] = "rest:http://10.0.10.80:8000/mini-m4"
RESTIC_BIN: Final[str] = "/usr/local/bin/restic"
RESTIC_PWFILE: Final[Path] = Path.home() / ".config" / "restic" / "mini-m4.pw"

#: Tag applied to every snapshot this job makes, so its snapshots can be
#: found without pattern matching on paths.
RESTIC_TAG: Final[str] = "cloudecode-history"

# ---------------------------------------------------------------------------
# Names inside one snapshot directory
# ---------------------------------------------------------------------------

ARCHIVE_ARTIFACT: Final[str] = "cloude-archive.db"
APP_ARTIFACT: Final[str] = "cloude.db"
MANIFEST_NAME: Final[str] = "MANIFEST.json"
REPO_VERIFY_NAME: Final[str] = "REPO-VERIFY.json"
RESTORE_PROOF_NAME: Final[str] = "RESTORE-PROOF.json"

# ---------------------------------------------------------------------------
# Thresholds
# ---------------------------------------------------------------------------

#: Freshness window for the liveness artifact. The schedule is daily, so two
#: days is one missed run plus slack. Same four-value vocabulary the corpus
#: ingester uses: current / stale / never_ran / cannot_determine.
FRESHNESS_WINDOW_SECONDS: Final[int] = 2 * 24 * 60 * 60

#: Free space required on the USB drive before a run starts, over and above
#: the size of the source.
FREE_SPACE_HEADROOM_BYTES: Final[int] = 20 * 1024 ** 3

#: Free space that must remain on the BOOT volume for a run to start at all.
#: This job writes only kilobytes there, but a machine this close to full is
#: not a machine to start long work on.
BOOT_VOLUME_FLOOR_BYTES: Final[int] = 10 * 1024 ** 3

#: A snapshot holding fewer rows than this in ``transcript_archives`` is
#: REJECTED. Floors catch the failure that actually matters: a structurally
#: valid but EMPTY database, which is what a re-init or a torn copy of a
#: freshly created file looks like. Measured 2026-09-17 at 24,681 rows and
#: rising; the floor sits well under that with room to shrink after a dedupe.
MIN_TRANSCRIPT_ARCHIVES: Final[int] = 20_000

#: Same idea for the raw artifact size.
MIN_ARCHIVE_BYTES: Final[int] = 4 * 1024 ** 3

#: How many local snapshot directories to keep on the USB drive. Two: the
#: newest is an immediately restorable copy that needs no network, and the
#: one behind it means a bad snapshot cannot leave the drive holding only
#: itself. Everything older than that is what the restic repository is for,
#: and the repository has its own retention.
KEEP_LOCAL_SNAPSHOTS: Final[int] = 2


def snapshot_dir(stamp: str) -> Path:
    """Directory for one run's artifacts on the USB drive.

    Inputs: stamp (str) - UTC ``YYYYmmddTHHMMSSZ``.
    Output: Path.
    Example: snapshot_dir("20260917T161503Z")
    """
    return STAGING_ROOT / f"history-{stamp}"


def usb_available() -> bool:
    """Is the USB drive mounted and writable right now?

    Description: an unplugged drive is a NAMED outcome, not a crash. The
      caller reports it as ``cannot_determine`` rather than as a backup
      failure, because nothing was found wrong with anything.
    Inputs: none. Output: bool.
    """
    return USB_VOLUME.is_dir() and os.access(USB_VOLUME, os.W_OK)


def ensure_dirs() -> None:
    """Create this job's own directories, on both volumes.

    Description: creates ONLY inside USB_ROOT on the external drive. The
      drive belongs to the owner and holds his own content; this job has one
      subdirectory and stays in it.
    Inputs: none. Output: None.
    """
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if usb_available():
        for path in (USB_ROOT, DUMP_DIR, RESTORE_PROOF_ROOT):
            path.mkdir(parents=True, exist_ok=True)
