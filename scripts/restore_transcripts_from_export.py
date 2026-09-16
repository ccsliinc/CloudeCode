#!/usr/bin/env python3
"""Restore transcripts from a hex export of an OFFLINE archive database.

WHY THIS EXISTS BESIDE ``scripts/restore_transcript.py`` RATHER THAN
INSTEAD OF IT. That script resolves a conversation by uuid against the
LIVE archive (``transcript_restore_resolve.restore_connection`` ->
``archive_db_path_for``). The bytes this one restores are NOT in the live
archive: they are in a cold 22 GB export sitting on the NAS, and the
files were deleted from disk before the live archive ever saw them. So
the RESOLVE stage cannot be reused. Every stage after it is reused
VERBATIM and not reimplemented:

* ``transcript_restore_target.resolve_target``  - containment, the
  refuse-if-present default, the parent check.
* ``transcript_restore_target.corroborate_directory`` - the slug rule as
  a cross-check that never decides.
* ``transcript_restore_write.write_transcript`` - home write guard, temp
  file in the same directory, fsync, ``os.replace``, fsync the
  directory, and the read-back re-hash.

THE ORDER IS ``plan_restore``'s ORDER, for ``plan_restore``'s REASON:
reconstruct and SELF-VERIFY before looking at the destination, so bytes
the archive does not vouch for can never reach a path decision.

SELF-VERIFICATION IS PER FILE AND IS NOT A SAMPLE. Each row's blob is
inflated, sha256'd and length-checked against the two columns the source
database recorded for it. A row that does not verify is NOT written and
is reported by source_path.

MTIME. ``ingest_source_mtime`` is the mtime the file had when it was
ingested, so it is reapplied with ``os.utime`` after a successful write
and the result is REPORTED rather than assumed - a corpus whose
chronology is all "today" is a corpus that has quietly lost a fact.
The atime is set to the same instant; there is no recorded atime to
restore and inventing a different one would be a second fiction.

DRY RUN IS THE DEFAULT. ``--apply`` is the only thing that writes.
"""

from __future__ import annotations

import argparse
import binascii
import gzip
import hashlib
import os
import sys
import zlib
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterator, List, NamedTuple, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.core.transcript_restore_outcomes import TARGET_READY, WRITTEN  # noqa: E402
from src.core.transcript_restore_target import (  # noqa: E402
    corroborate_directory,
    resolve_target,
)
from src.core.transcript_restore_write import write_transcript  # noqa: E402

#: Field count of one export line. Seven columns, blob hex last.
EXPORT_FIELDS: int = 7


class Row(NamedTuple):
    """One exported archive row, before anything has been inflated.

    Description: the seven columns of the export, blob still hex.
    Inputs: built by :func:`read_export`.
    Output: n/a (data holder).
    """

    archive_id: int
    source_path: str
    content_sha256: str
    raw_byte_length: int
    compressed_byte_length: int
    ingest_source_mtime: str
    blob_hex: str


class Verified(NamedTuple):
    """A row whose bytes were rebuilt and checked, or the reason they were not.

    Description: ``ok`` False means the bytes are refused and ``detail``
      says why; ``data`` is then empty and must not be written.
    Inputs: built by :func:`verify_row`.
    Output: n/a (data holder).
    """

    row: Row
    ok: bool
    data: bytes
    detail: str


def read_export(path: Path) -> Iterator[Row]:
    """Yield every row of a gzipped pipe-separated export.

    Description: splits on ``|`` with a bounded maxsplit so a pipe could
      never appear in the blob hex and steal a field. A line with the
      wrong field count raises rather than being skipped, because a
      silently dropped row is a silently missing transcript.
    Inputs: path (Path) - the ``.txt.gz`` export.
    Output: Iterator[Row].
    Raises: ValueError - a malformed line, named by its line number.
    Example: next(read_export(Path('blobs.txt.gz'))).source_path
    """
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            line = line.rstrip("\n")
            if not line:
                continue
            parts = line.split("|", EXPORT_FIELDS - 1)
            if len(parts) != EXPORT_FIELDS:
                raise ValueError(f"line {number}: expected {EXPORT_FIELDS} fields, got {len(parts)}")
            yield Row(
                archive_id=int(parts[0]),
                source_path=parts[1],
                content_sha256=parts[2],
                raw_byte_length=int(parts[3]),
                compressed_byte_length=int(parts[4]),
                ingest_source_mtime=parts[5],
                blob_hex=parts[6],
            )


def verify_row(row: Row) -> Verified:
    """Inflate one row's blob and check it against its own two columns.

    Description: the self-consistency claim ``reconstruct_row`` makes,
      applied to an offline export. sha256 AND byte length are both
      compared; either disagreeing is a refusal, because a length match
      with a hash mismatch and a hash match with a length mismatch are
      different faults and neither is acceptable.
    Inputs: row (Row).
    Output: Verified.
    Example: verify_row(row).ok -> True
    """
    try:
        compressed = binascii.unhexlify(row.blob_hex)
    except binascii.Error as exc:
        return Verified(row, False, b"", f"blob hex is not decodable: {exc}")
    if len(compressed) != row.compressed_byte_length:
        return Verified(
            row,
            False,
            b"",
            f"blob is {len(compressed)} bytes, column says {row.compressed_byte_length}",
        )
    try:
        data = zlib.decompress(compressed)
    except zlib.error as exc:
        return Verified(row, False, b"", f"zlib inflate failed: {exc}")
    digest = hashlib.sha256(data).hexdigest()
    if digest != row.content_sha256:
        return Verified(
            row, False, b"", f"sha256 {digest} != recorded {row.content_sha256}"
        )
    if len(data) != row.raw_byte_length:
        return Verified(
            row,
            False,
            b"",
            f"inflated to {len(data)} bytes, column says {row.raw_byte_length}",
        )
    return Verified(row, True, data, "")


def mtime_epoch(stamp: str) -> Optional[float]:
    """Parse an ISO8601 ``ingest_source_mtime`` into a POSIX timestamp.

    Description: returns None for an absent or unparseable stamp, which
      the caller reports as "mtime not restored" rather than substituting
      the current time. An invented mtime is worse than a visible gap.
    Inputs: stamp (str) - e.g. '2026-08-24T15:52:23.050000Z'.
    Output: float | None.
    Example: mtime_epoch('2026-01-01T00:00:00Z') -> 1767225600.0
    """
    if not stamp:
        return None
    text = stamp.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def main() -> int:
    """Plan, report, and on ``--apply`` perform the restore.

    Inputs: argv.
    Output: int exit status - 0 only when nothing was refused.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path, help="gzipped pipe-separated export")
    parser.add_argument("--apply", action="store_true", help="actually write (default: dry run)")
    parser.add_argument(
        "--corpus-root", type=Path, default=None, help="override ~/.claude/projects"
    )
    args = parser.parse_args()

    rows = list(read_export(args.export))
    print(f"export rows: {len(rows)}")

    outcomes: Counter = Counter()
    refused: List[str] = []
    per_dir: Dict[str, int] = defaultdict(int)
    per_dir_bytes: Dict[str, int] = defaultdict(int)
    corroboration: Counter = Counter()
    written = 0
    mtime_set = 0
    mtime_failed: List[str] = []
    total_bytes = 0

    for row in rows:
        checked = verify_row(row)
        if not checked.ok:
            outcomes["verify_failed"] += 1
            refused.append(f"verify_failed  {row.source_path}  {checked.detail}")
            continue
        outcomes["verified"] += 1

        decision = resolve_target(
            row.source_path,
            len(checked.data),
            corpus_root=args.corpus_root,
            overwrite=False,
            create_dirs=False,
        )
        if decision.outcome != TARGET_READY:
            outcomes[decision.outcome] += 1
            refused.append(f"{decision.outcome}  {row.source_path}  {decision.detail}")
            continue

        corroboration[corroborate_directory(checked.data, row.source_path).verdict] += 1
        parent = str(decision.path.parent)
        per_dir[parent] += 1
        per_dir_bytes[parent] += len(checked.data)
        total_bytes += len(checked.data)

        if not args.apply:
            outcomes["would_write"] += 1
            continue

        result = write_transcript(
            decision.path,
            checked.data,
            row.content_sha256,
            allow_overwrite=False,
            create_dirs=False,
        )
        outcomes[result.outcome] += 1
        if result.outcome != WRITTEN:
            refused.append(f"{result.outcome}  {row.source_path}  {result.detail}")
            continue
        written += 1
        stamp = mtime_epoch(row.ingest_source_mtime)
        if stamp is None:
            mtime_failed.append(f"{row.source_path} (unparseable {row.ingest_source_mtime!r})")
            continue
        try:
            os.utime(decision.path, (stamp, stamp))
            mtime_set += 1
        except OSError as exc:
            mtime_failed.append(f"{row.source_path} ({exc})")

    print(f"\nmode: {'APPLY' if args.apply else 'DRY RUN'}")
    print("outcomes:")
    for name, count in sorted(outcomes.items()):
        print(f"  {count:6d}  {name}")
    print(f"\ncorroboration (slug rule vs recorded dir, reporting only): {dict(corroboration)}")
    print(f"total bytes that would land / landed: {total_bytes}")
    print("\nper destination directory:")
    for directory in sorted(per_dir):
        print(f"  {per_dir[directory]:5d} files  {per_dir_bytes[directory]:11d} bytes  {directory}")
    if args.apply:
        print(f"\nwritten: {written}   mtime restored: {mtime_set}   mtime NOT restored: {len(mtime_failed)}")
        for line in mtime_failed[:20]:
            print(f"  mtime_failed  {line}")
    if refused:
        print(f"\nREFUSED ({len(refused)}):")
        for line in refused:
            print(f"  {line}")
    return 0 if not refused else 1


if __name__ == "__main__":
    raise SystemExit(main())
