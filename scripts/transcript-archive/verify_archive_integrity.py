#!/usr/bin/env python3
"""Whole-corpus integrity check of a LIVE transcript archive database.

WHY THIS EXISTS, AND WHY corpus_roundtrip_harness.py IS NOT IT. The
harness beside this file re-ingests every file from disk into a THROWAWAY
database and verifies the round trip there. That proves ingest and export
for a SINGLE FULL COPY, and it cannot prove anything else, because it
never calls transcript_prefix_dedupe or transcript_content_dedupe: every
row it creates has ``superseded_by_archive_id`` NULL by construction. The
live archive is not that shape. Measured on the owner's box 2026-09-14,
3,889 of 23,429 rows (16.6 percent) carry a supersession pointer and hold
an 8-byte empty sentinel in ``content_gzip`` instead of their own bytes.

THE DEFECT THIS SCRIPT EXISTS TO PREVENT SOMEONE RE-DISCOVERING. Reading
``content_gzip`` directly and hashing it reports every one of those rows
as corrupt. They are not. Their bytes live forward along
``superseded_by_archive_id`` and
:func:`src.core.transcript_archive.export_archive` is the only correct
reader. A verifier that skips it measures a column, not a reconstruction.

THREE OUTCOMES AGAINST THE SOURCE FILE, NEVER TWO, and a fourth verdict
that is deliberately NOT a failure:

  byte_identical      the reconstruction equals the file on disk now
  prefix_of_source    the reconstruction equals the first N bytes of the
                      file (N is this row's own raw_byte_length). This is
                      a PASS for a superseded row: the row is a snapshot
                      of the file as it was at that ingest and the file
                      has grown since. It is a FINDING on a head-of-chain
                      row, which normally means the file grew after the
                      last ingest pass and has not been re-ingested yet.
  mismatch            neither. The only genuinely bad outcome.
  could_not_evaluate  the source file could not be read. Never counted a
                      pass and never counted a failure. On the owner's
                      box this is 2,524 rows whose transcripts were
                      deleted from ~/.claude/projects, so the archive is
                      the only remaining copy and there is no ground
                      truth left to compare against.

SELF-CONSISTENCY IS REPORTED SEPARATELY, and the distinction matters.
``sha256(export_archive(row)) == row.content_sha256`` proves the
reconstruction reproduces WHAT WAS INGESTED. It does not prove what was
ingested matches disk. Those are different claims and a resume feature
depends on both, so both are printed.

WHICH DATABASE, AND WHY THE SCRIPT REFUSES RATHER THAN GUESSES. Until
2026-09-14 ``transcript_archives`` lived inside ``cloude.db``. The
archive db split moved it, with the whole ``transcript_``, ``message_``
and ``archive_`` family, into a SIBLING FILE, ``cloude-archive.db``
(``src/core/archive_db_partition.py`` is the partition and the filename
constant). Post-split, ``cloude.db`` is the small app database - sessions,
projects, groups - and holds no archive table at all.

So ``--db`` must name ``cloude-archive.db`` on any split install. Two
failure modes follow and both are handled explicitly, because a verifier
that checks the wrong file is worse than no verifier:

  - Pointed at a post-split ``cloude.db``, the table is simply absent.
    That used to raise an uncaught ``sqlite3.OperationalError`` and exit
    1, which a wrapper reads as "mismatches found". It is not a finding
    about the data, it is a run that did not happen, so it now refuses
    with exit code 2, the same "could not evaluate" discipline the
    per-row outcomes use.
  - Pointed at a PRE-SPLIT snapshot - a ``cloude.db.bak-*`` left beside
    the live files, or a copy taken before the split - every query
    succeeds and the report comes back green about a frozen file. That
    one cannot be caught by a missing table, so the side is MEASURED:
    the split writes a durable ``archive_split_origin`` table into the
    new file, so its presence names this database ``post_split_archive``
    and its absence names it ``pre_split_combined``. The verdict is
    printed in the report header and carried in the JSON, so no result
    can be read without knowing which file produced it.

READ-ONLY. The database is opened with ``mode=ro`` plus
``PRAGMA query_only=ON``, so this is safe to run against the live file
while the corpus ingester is writing to it. Nothing under the corpus root
is opened for anything but reading.

Usage:
  python3 verify_archive_integrity.py --db ~/Library/Application\\ Support/CloudeCode/cloude-archive.db
  python3 verify_archive_integrity.py --db PATH [--corpus-root PATH]
                                      [--limit N] [--json OUT.json]
                                      [--allow-pre-split] [--self-test]
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import sqlite3
import sys
import time
import zlib
from typing import Dict, Iterator, List, Optional, Tuple

#: Default location of the corpus this archive was built from.
DEFAULT_CORPUS_ROOT = os.path.expanduser("~/.claude/projects")

#: The blob a superseded row carries in place of its own bytes:
#: zlib.compress(b"", 9). Imported conceptually from
#: src/core/transcript_prefix_dedupe.py, recomputed here so this script
#: runs against a bare system Python with no repo on sys.path, the same
#: constraint corpus_roundtrip_harness.py is built for.
SENTINEL_GZIP = zlib.compress(b"", 9)

#: sha256 of the empty string. A row whose true content was genuinely
#: empty hashes to this, so the naive check passes on it by coincidence.
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()

#: The table this script verifies. Post-split it lives in
#: cloude-archive.db; pre-split it lived in cloude.db. Named once so the
#: preflight and the pass cannot disagree about what they are looking for.
ARCHIVE_TABLE = "transcript_archives"

#: Written into cloude-archive.db by the archive db split
#: (src/core/archive_db_split.py, ORIGIN_TABLE) and kept, because the
#: reverse pass reads the pre-strip DDL back out of it. Its presence is
#: therefore a durable, measured marker that this file is the split-off
#: archive and not a pre-split combined database.
SPLIT_ORIGIN_TABLE = "archive_split_origin"

#: The filename src/core/archive_db_partition.ARCHIVE_DB_FILENAME
#: declares. Repeated as a literal, not imported, for the same reason
#: SENTINEL_GZIP is recomputed: this script must run on a bare system
#: Python with no repo on sys.path. It is used only in messages.
ARCHIVE_DB_FILENAME = "cloude-archive.db"

SIDE_POST_SPLIT = "post_split_archive"
SIDE_PRE_SPLIT = "pre_split_combined"
SIDE_NO_TABLE = "no_archive_table"

OUTCOME_IDENTICAL = "byte_identical"
OUTCOME_PREFIX = "prefix_of_source"
OUTCOME_MISMATCH = "mismatch"
OUTCOME_CANNOT = "could_not_evaluate"


class ChainError(Exception):
    """A supersession chain could not be walked to a content-holding row."""


def open_readonly(db_path: str) -> sqlite3.Connection:
    """Open cloude.db read-only, safe against the live writer.

    Description: URI mode=ro plus PRAGMA query_only, so no code path in
      this script can write to the owner's live database even by
      accident.
    Inputs: db_path (str) - path to cloude.db.
    Output: sqlite3.Connection with a Row row_factory.
    Example: open_readonly("/tmp/cloude.db").execute("SELECT 1")
    """
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


def has_table(conn: sqlite3.Connection, name: str) -> bool:
    """Say whether a table exists, without letting a query raise.

    Description: sqlite_master lookup rather than a trial SELECT, so a
      missing table is an answer instead of an exception.
    Inputs: conn (sqlite3.Connection), name (str) - exact table name.
    Output: bool.
    Example: has_table(conn, "transcript_archives") -> True
    """
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        (name,),
    ).fetchone()
    return row is not None


def archive_side(conn: sqlite3.Connection) -> str:
    """Name which side of the archive db split this database is.

    Description: three outcomes, measured from what the file contains
      rather than from its filename, because the hazard this exists for
      is a pre-split BACKUP that answers every query correctly while
      describing a frozen file. SIDE_NO_TABLE is a refusal condition;
      SIDE_PRE_SPLIT is a warning the caller may override deliberately;
      only SIDE_POST_SPLIT is the live archive on a split install.
    Inputs: conn (sqlite3.Connection) - opened read-only.
    Output: str - one of SIDE_POST_SPLIT, SIDE_PRE_SPLIT, SIDE_NO_TABLE.
    Example: archive_side(open_readonly("cloude-archive.db"))
             -> "post_split_archive"
    """
    if not has_table(conn, ARCHIVE_TABLE):
        return SIDE_NO_TABLE
    if has_table(conn, SPLIT_ORIGIN_TABLE):
        return SIDE_POST_SPLIT
    return SIDE_PRE_SPLIT


def db_provenance(db_path: str) -> Dict[str, object]:
    """Describe the file being read, so a report names its own source.

    Description: path, size and mtime. A green report that does not say
      which file it came from is the exact thing that makes a stale
      snapshot dangerous.
    Inputs: db_path (str).
    Output: dict with path, bytes and mtime_utc keys; the latter two are
      None when the file could not be stat'ed, never invented.
    Example: db_provenance("/tmp/a.db")["path"] -> "/tmp/a.db"
    """
    try:
        stat = os.stat(db_path)
    except OSError:
        return {"path": db_path, "bytes": None, "mtime_utc": None}
    return {
        "path": db_path,
        "bytes": stat.st_size,
        "mtime_utc": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime)
        ),
    }


class ChainReader:
    """Reconstruct archive rows, walking supersession, with a small cache.

    Description: the read side of prefix dedupe and content dedupe, kept
      byte-for-byte equivalent to
      src.core.transcript_archive.export_archive - walk
      ``superseded_by_archive_id`` to the row that still holds real
      content, decompress THAT row once, and slice to the ORIGINALLY
      requested row's own ``raw_byte_length``. Slicing once at the end is
      correct because every link was proven a strict byte prefix at the
      moment it was recorded.
    Inputs: conn (sqlite3.Connection), cache_size (int) - how many
      decompressed terminal blobs to hold at once. Bounded because the
      largest single transcript measured in this corpus is about 29 MB.
    Output: n/a (holder). Call :meth:`export`.
    Example: ChainReader(conn).export(22422) -> b'{"type":"user"...'
    """

    def __init__(self, conn: sqlite3.Connection, cache_size: int = 4) -> None:
        self._conn = conn
        self._cache: "collections.OrderedDict[int, bytes]" = collections.OrderedDict()
        self._cache_size = max(1, cache_size)

    def _row(self, archive_id: int) -> Optional[sqlite3.Row]:
        return self._conn.execute(
            "SELECT id, content_gzip, raw_byte_length, superseded_by_archive_id"
            " FROM transcript_archives WHERE id = ?",
            (archive_id,),
        ).fetchone()

    def export(self, archive_id: int) -> Tuple[bytes, int]:
        """Return (reconstructed bytes, chain depth) for one archive row.

        Description: depth 0 means the row holds its own bytes.
        Inputs: archive_id (int).
        Output: (bytes, int).
        Raises: ChainError - no such row, a broken pointer, or a cycle.
          zlib.error - the terminal blob is genuinely corrupt.
        Example: reader.export(1) -> (b'{"a":1}\\n', 0)
        """
        row = self._row(archive_id)
        if row is None:
            raise ChainError(f"no transcript_archives row with id={archive_id}")
        target_len = int(row["raw_byte_length"])
        visited = {archive_id}
        current = row
        depth = 0
        while current["superseded_by_archive_id"] is not None:
            next_id = int(current["superseded_by_archive_id"])
            if next_id in visited:
                raise ChainError(f"supersession cycle from archive_id={archive_id}")
            visited.add(next_id)
            nxt = self._row(next_id)
            if nxt is None:
                raise ChainError(
                    f"broken supersession chain: archive_id={next_id} missing"
                    f" (requested from archive_id={archive_id})"
                )
            current = nxt
            depth += 1
        terminal_id = int(current["id"])
        blob = self._cache.get(terminal_id)
        if blob is None:
            blob = zlib.decompress(current["content_gzip"])
            self._cache[terminal_id] = blob
            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)
        else:
            self._cache.move_to_end(terminal_id)
        return blob[:target_len], depth


def classify(recon: bytes, disk: Optional[bytes]) -> Tuple[str, Optional[int]]:
    """Name the reconstruction's relationship to the source file.

    Description: the three-outcome rule, plus the first differing byte
      offset when and only when the outcome is a mismatch.
    Inputs: recon (bytes) - what the database reconstructs. disk (bytes
      or None) - the file's current bytes, None when unreadable.
    Output: (outcome str, first_diff_offset int or None).
    Example: classify(b"ab", b"abc") -> ("prefix_of_source", None)
    """
    if disk is None:
        return OUTCOME_CANNOT, None
    if recon == disk:
        return OUTCOME_IDENTICAL, None
    if len(recon) <= len(disk) and disk[: len(recon)] == recon:
        return OUTCOME_PREFIX, None
    limit = min(len(recon), len(disk))
    for i in range(limit):
        if recon[i] != disk[i]:
            return OUTCOME_MISMATCH, i
    return OUTCOME_MISMATCH, limit


def stratum_of(row: sqlite3.Row) -> str:
    """Name the population a row belongs to, for the stratified report.

    Description: the strata that actually differ in reconstruction
      mechanics - whether the row holds its own bytes, and why not when
      it does not.
    Inputs: row (sqlite3.Row) with superseded_by_archive_id, growth_kind,
      dedupe_kind.
    Output: str.
    Example: stratum_of(row) -> "superseded/append"
    """
    if row["superseded_by_archive_id"] is None:
        return f"own_bytes/{row['growth_kind']}"
    if row["dedupe_kind"]:
        return f"superseded/{row['growth_kind']}/{row['dedupe_kind']}"
    return f"superseded/{row['growth_kind']}"


def iter_paths(conn: sqlite3.Connection, limit: Optional[int]) -> Iterator[str]:
    """Yield distinct source_path values, so each disk file is read once.

    Description: grouping by path is what keeps this pass linear in the
      corpus rather than in the row count, which is larger because a
      growing transcript has many rows for one path.
    Inputs: conn, limit (int or None).
    Output: Iterator[str].
    Example: next(iter_paths(conn, 1)) -> "-Users-jsugamele/x.jsonl"
    """
    sql = "SELECT DISTINCT source_path FROM transcript_archives"
    if limit:
        sql += f" LIMIT {int(limit)}"
    for row in conn.execute(sql):
        yield row[0]


def run(db_path: str, corpus_root: str, limit: Optional[int]) -> Dict[str, object]:
    """Verify every archive row and return the stratified report.

    Description: the whole pass. Reads each source file once and checks
      every row that names it.
    Inputs: db_path (str), corpus_root (str), limit (int or None) - cap
      on distinct source paths, for a quick run.
    Output: dict - counts by outcome, counts by stratum, the self
      consistency tally, and the full detail of every mismatch.
    Example: run("/tmp/cloude.db", "/tmp/projects", 5)["mismatch"] -> 0
    """
    conn = open_readonly(db_path)
    side = archive_side(conn)
    reader = ChainReader(conn)
    outcomes: "collections.Counter[str]" = collections.Counter()
    by_stratum: Dict[str, "collections.Counter[str]"] = collections.defaultdict(
        collections.Counter
    )
    sha_ok = 0
    sha_bad: List[Dict[str, object]] = []
    chain_errors: List[Dict[str, object]] = []
    mismatches: List[Dict[str, object]] = []
    rows_seen = 0
    started = time.time()

    for source_path in iter_paths(conn, limit):
        full = os.path.join(corpus_root, source_path)
        try:
            with open(full, "rb") as handle:
                disk: Optional[bytes] = handle.read()
        except OSError:
            disk = None
        rows = conn.execute(
            "SELECT id, content_sha256, raw_byte_length, growth_kind, dedupe_kind,"
            "       superseded_by_archive_id, ingested_at"
            " FROM transcript_archives WHERE source_path = ?",
            (source_path,),
        ).fetchall()
        for row in rows:
            rows_seen += 1
            stratum = stratum_of(row)
            try:
                recon, _depth = reader.export(int(row["id"]))
            except (ChainError, zlib.error) as exc:
                outcomes[OUTCOME_CANNOT] += 1
                by_stratum[stratum][OUTCOME_CANNOT] += 1
                chain_errors.append(
                    {
                        "id": int(row["id"]),
                        "reason": f"{type(exc).__name__}: {exc}",
                        "source_path": source_path,
                    }
                )
                continue
            digest = hashlib.sha256(recon).hexdigest()
            if digest == row["content_sha256"] and len(recon) == int(
                row["raw_byte_length"]
            ):
                sha_ok += 1
            else:
                sha_bad.append(
                    {
                        "id": int(row["id"]),
                        "recorded_sha256": row["content_sha256"],
                        "reconstructed_sha256": digest,
                        "recorded_len": int(row["raw_byte_length"]),
                        "reconstructed_len": len(recon),
                        "source_path": source_path,
                    }
                )
            outcome, first_diff = classify(recon, disk)
            outcomes[outcome] += 1
            by_stratum[stratum][outcome] += 1
            if outcome == OUTCOME_MISMATCH:
                mismatches.append(
                    {
                        "id": int(row["id"]),
                        "stratum": stratum,
                        "reconstructed_len": len(recon),
                        "disk_len": len(disk) if disk is not None else -1,
                        "recorded_raw_byte_length": int(row["raw_byte_length"]),
                        "first_diff_offset": first_diff,
                        "ingested_at": row["ingested_at"],
                        "source_path": source_path,
                    }
                )
    conn.close()
    return {
        "database": db_provenance(db_path),
        "archive_side": side,
        "rows": rows_seen,
        "elapsed_seconds": round(time.time() - started, 1),
        "outcomes": dict(outcomes),
        "by_stratum": {k: dict(v) for k, v in sorted(by_stratum.items())},
        "self_consistent": sha_ok,
        "self_inconsistent": sha_bad,
        "chain_errors": chain_errors,
        "mismatches": mismatches,
    }


def self_test() -> int:
    """Prove this verifier can FAIL before trusting a run where it passed.

    Description: a matcher that always finds something is worse than
      useless, and so is a verifier that cannot report a fault. This
      builds a tiny in-memory archive, supersedes a row exactly the way
      transcript_prefix_dedupe does, and asserts four things: the chain
      walk reconstructs the superseded row byte-exactly, the naive read
      of its content_gzip does NOT, a flipped bit is caught, and a
      truncation is caught.
    Inputs: none.
    Output: int exit code, 0 when every assertion held.
    Example: self_test() -> 0
    """
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE transcript_archives (id INTEGER PRIMARY KEY,"
        " source_path TEXT, content_gzip BLOB, content_sha256 TEXT,"
        " raw_byte_length INTEGER, growth_kind TEXT, dedupe_kind TEXT,"
        " superseded_by_archive_id INTEGER, ingested_at TEXT)"
    )
    old = b'{"type":"user","n":1}\n'
    new = old + b'{"type":"assistant","n":2}\n'
    conn.execute(
        "INSERT INTO transcript_archives VALUES (2,'p.jsonl',?,?,?,'append',NULL,NULL,'t')",
        (zlib.compress(new, 9), hashlib.sha256(new).hexdigest(), len(new)),
    )
    conn.execute(
        "INSERT INTO transcript_archives VALUES (1,'p.jsonl',?,?,?,'initial',NULL,2,'t')",
        (SENTINEL_GZIP, hashlib.sha256(old).hexdigest(), len(old)),
    )
    reader = ChainReader(conn)
    recon, depth = reader.export(1)
    failures = []
    if recon != old or depth != 1:
        failures.append("chain walk did not reconstruct the superseded row")
    naive = zlib.decompress(conn.execute(
        "SELECT content_gzip FROM transcript_archives WHERE id=1").fetchone()[0])
    if hashlib.sha256(naive).hexdigest() == hashlib.sha256(old).hexdigest():
        failures.append("naive content_gzip read was expected to FAIL and did not")
    flipped = bytearray(old)
    flipped[0] ^= 0x01
    if classify(bytes(flipped), old)[0] != OUTCOME_MISMATCH:
        failures.append("a flipped bit was not reported as a mismatch")
    if classify(old[:-1], old)[0] != OUTCOME_PREFIX:
        failures.append("a truncation was not reported as a prefix")
    if classify(old + b"x", old)[0] != OUTCOME_MISMATCH:
        failures.append("an over-long reconstruction was not reported as a mismatch")

    # The database-side discriminator, with its negative controls. A
    # guard that cannot say "wrong file" is not a guard, and one that
    # says it about the right file is worse than none, so all three
    # sides are exercised against real sqlite rather than asserted.
    if archive_side(conn) != SIDE_PRE_SPLIT:
        failures.append(
            "a database with the archive table and no split-origin table"
            " was not named pre_split_combined")
    conn.execute(f"CREATE TABLE {SPLIT_ORIGIN_TABLE} (name TEXT)")
    if archive_side(conn) != SIDE_POST_SPLIT:
        failures.append(
            "a database carrying archive_split_origin was not named"
            " post_split_archive")
    bare = sqlite3.connect(":memory:")
    bare.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY)")
    if archive_side(bare) != SIDE_NO_TABLE:
        failures.append(
            "a post-split cloude.db (no transcript_archives) was not"
            " refused as no_archive_table")
    bare.close()
    for line in failures:
        print(f"SELF-TEST FAILED: {line}", file=sys.stderr)
    if not failures:
        print("self-test passed: the verifier reconstructs, and it can fail")
    return 1 if failures else 0


def corpus_root_display(root: str) -> str:
    """Render the corpus root, saying so when it is not there at all.

    Description: a run whose corpus root does not exist produces
      could_not_evaluate for every row, which is a legitimate result for
      a machine whose transcripts were deleted and a misleading one for a
      mistyped path. Saying which is cheap.
    Inputs: root (str) - the --corpus-root value.
    Output: str.
    Example: corpus_root_display("/nope") -> "/nope (MISSING)"
    """
    return root if os.path.isdir(root) else f"{root} (MISSING)"


def main(argv: Optional[List[str]] = None) -> int:
    """Parse arguments, run the pass, print the stratified report.

    Inputs: argv (list of str or None).
    Output: int exit code. 0 clean, 1 at least one mismatch or chain
      error, 2 the run itself could not be performed. 2 is not a pass.
    Example: main(["--db", "/tmp/cloude.db", "--limit", "5"]) -> 0
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--db",
        help=f"path to {ARCHIVE_DB_FILENAME} (a pre-split install, or a"
             " pre-split backup, keeps the archive inside cloude.db)")
    parser.add_argument("--corpus-root", default=DEFAULT_CORPUS_ROOT)
    parser.add_argument("--limit", type=int, default=None,
                        help="cap on distinct source paths, for a quick run")
    parser.add_argument("--json", help="write the full report here")
    parser.add_argument(
        "--allow-pre-split", action="store_true",
        help="proceed against a pre-split database (one holding the"
             " archive inside cloude.db). Refused by default because the"
             " usual way to reach one today is a stale cloude.db.bak-*"
             " snapshot, which verifies green about a frozen file.")
    parser.add_argument("--self-test", action="store_true",
                        help="prove the verifier can fail, then exit")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()
    if not args.db:
        print("--db is required (or use --self-test)", file=sys.stderr)
        return 2
    if not os.path.exists(args.db):
        print(f"no such database: {args.db}", file=sys.stderr)
        return 2

    # Preflight. Both refusals below exit 2, never 1: neither is a
    # finding about the archive's contents, both are a run that did not
    # happen, and this script's contract is that 2 is not a pass.
    try:
        probe = open_readonly(args.db)
        side = archive_side(probe)
        probe.close()
    except sqlite3.Error as exc:
        print(f"could not open {args.db} read-only: {exc}", file=sys.stderr)
        return 2
    if side == SIDE_NO_TABLE:
        print(
            f"{args.db} has no {ARCHIVE_TABLE} table, so there is nothing"
            f" here to verify.\n"
            f"Since the archive db split (2026-09-14) the archive lives in"
            f" the sibling file {ARCHIVE_DB_FILENAME}; cloude.db keeps only"
            f" sessions, projects and groups.\n"
            f"Re-run with --db <state dir>/{ARCHIVE_DB_FILENAME}.",
            file=sys.stderr,
        )
        return 2
    if side == SIDE_PRE_SPLIT and not args.allow_pre_split:
        print(
            f"{args.db} holds {ARCHIVE_TABLE} but no {SPLIT_ORIGIN_TABLE},"
            f" so it is a PRE-SPLIT database.\n"
            f"On a split install the only files in that shape are stale"
            f" copies (cloude.db.bak-*, an online backup, an old export),"
            f" and verifying one returns a clean report about a frozen"
            f" file.\n"
            f"Point --db at {ARCHIVE_DB_FILENAME}, or pass"
            f" --allow-pre-split if a pre-split database is genuinely"
            f" what you meant to check.",
            file=sys.stderr,
        )
        return 2

    report = run(args.db, args.corpus_root, args.limit)
    outcomes = report["outcomes"]
    provenance = report["database"]
    print(f"database: {provenance['path']}")
    print(f"  side={report['archive_side']}  bytes={provenance['bytes']}"
          f"  mtime={provenance['mtime_utc']}")
    print(f"corpus root: {corpus_root_display(args.corpus_root)}")
    print(f"rows checked: {report['rows']}  in {report['elapsed_seconds']}s")
    print("\noutcome against the source file on disk:")
    for name in (OUTCOME_IDENTICAL, OUTCOME_PREFIX, OUTCOME_MISMATCH, OUTCOME_CANNOT):
        print(f"  {name:<20} {outcomes.get(name, 0)}")
    print(f"\nself consistent (sha256 and length both match the row): "
          f"{report['self_consistent']} of {report['rows']}")
    if report["self_inconsistent"]:
        print(f"  SELF INCONSISTENT: {len(report['self_inconsistent'])}")
    print("\nby stratum:")
    for stratum, counts in report["by_stratum"].items():
        total = sum(counts.values())
        detail = "  ".join(f"{k}={v}" for k, v in sorted(counts.items()))
        print(f"  {stratum:<42} n={total:<7} {detail}")
    if report["mismatches"]:
        print(f"\nMISMATCHES ({len(report['mismatches'])}):")
        for item in report["mismatches"][:20]:
            print(f"  {item}")
    if report["chain_errors"]:
        print(f"\nCHAIN ERRORS ({len(report['chain_errors'])}):")
        for item in report["chain_errors"][:20]:
            print(f"  {item}")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
        print(f"\nfull report written to {args.json}")
    return 1 if (report["mismatches"] or report["chain_errors"]
                 or report["self_inconsistent"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
