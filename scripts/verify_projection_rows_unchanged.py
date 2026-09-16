"""Prove the prescan changed the projection's SPEED and not its ROWS.

Usage:
    ./venv/bin/python3 scripts/verify_projection_rows_unchanged.py [count]

Projects a real sample of this machine's archives TWICE into two
throwaway databases - once with the credential prescan
(:mod:`src.core.message_secret_prescan`, what ``project_one`` does now)
and once without it (what it did before issue 224) - then compares every
column of every ``message_*`` table by CONTENT HASH.

A COUNT COMPARISON WOULD NOT BE ENOUGH and that is the whole reason this
exists. The same number of secret findings landing on the wrong bodies,
or at the wrong offsets, is a count that matches and a corpus that leaks:
``archive_snippet_gate`` cuts its preview window around
``match_offset``, so an offset that moved is a window that moves with it.
So the comparison is a sha256 over ``quote()`` of every column of every
row, in rowid order.

THE NEGATIVE CONTROL IS ENFORCED. A sample carrying no credentials at
all would report "identical" perfectly happily while proving nothing
about the code path under test, so this REFUSES to pass unless the run
actually recorded findings.

Read-only against the live archive; every write goes to a throwaway file.
"""
import hashlib
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from typing import Dict, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.core.db_steps import apply_message_model_schema  # noqa: E402
from src.core.message_body_codec import register_body_functions  # noqa: E402
from src.core.message_model_ingest import ingest_lines  # noqa: E402
from src.core.message_projection import _split_source_lines  # noqa: E402
from src.core.message_secret_prescan import prescan_lines  # noqa: E402
from src.core.transcript_archive import export_archive  # noqa: E402

STATE = Path("/Users/jsugamele/Library/Application Support/CloudeCode")

#: Read-only URI. The live archive is never this script's to write.
LIVE_URI = f"file:{STATE / 'cloude-archive.db'}?mode=ro"

#: Every table the projection writes. Named explicitly rather than
#: discovered with a LIKE, so a new table that nothing compares is a
#: visible omission here instead of a silent gap.
TABLES = (
    "message_transcripts", "message_bodies", "message_appearances",
    "message_content_blocks", "message_ingest_findings",
    "message_secret_findings", "message_body_block_status",
    "message_record_types", "message_roles", "message_models",
    "message_compact_subtypes", "message_block_types",
)

#: Size band for the sample. The floor skips near-empty files that would
#: pad the count without exercising anything; the ceiling keeps one run
#: to a few minutes. The 244 MB outlier has its own harness in
#: scripts/measure_projection_lock_hold.py.
MIN_BYTES, MAX_BYTES = 2_000, 4_000_000


def fresh_target() -> sqlite3.Connection:
    """Open a throwaway database at the message-model schema.

    Inputs: none.
    Output: sqlite3.Connection.
    Example: fresh_target().execute("SELECT 1")
    """
    path = Path(tempfile.mkdtemp()) / "compare.db"
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    register_body_functions(conn)
    apply_message_model_schema(conn)
    return conn


def content_digest(conn: sqlite3.Connection) -> Dict[str, Tuple[str, int]]:
    """Hash every column of every row of every model table.

    Description: ``quote()`` renders each value in a form that separates
      a NULL from an empty string and a blob from text, which a bare
      string join would not.
    Inputs: conn (sqlite3.Connection).
    Output: dict of table -> (sha256 hex, row count).
    Example: content_digest(conn)["message_bodies"][1] -> 31691
    """
    out: Dict[str, Tuple[str, int]] = {}
    for table in TABLES:
        cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
        if not cols:
            out[table] = ("table_missing", 0)
            continue
        selected = ", ".join(f"quote({c})" for c in cols)
        digest = hashlib.sha256()
        count = 0
        for row in conn.execute(
            f"SELECT {selected} FROM {table} ORDER BY rowid"
        ):
            digest.update(repr(tuple(row)).encode("utf-8", "surrogateescape"))
            count += 1
        out[table] = (digest.hexdigest(), count)
    return out


def main() -> int:
    """Run the comparison and report. Returns a process exit code.

    Output: int - 0 when every table matched and findings were recorded.
    """
    wanted = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    live = sqlite3.connect(LIVE_URI, uri=True)
    live.row_factory = sqlite3.Row
    rows = live.execute(
        "SELECT id, raw_byte_length FROM transcript_archives "
        "WHERE superseded_by_archive_id IS NULL "
        "  AND raw_byte_length BETWEEN ? AND ? "
        "ORDER BY ingested_at DESC LIMIT ?",
        (MIN_BYTES, MAX_BYTES, wanted * 3),
    ).fetchall()
    sample = rows[::3][:wanted]
    total_mb = sum(r["raw_byte_length"] for r in sample) / 1e6
    print(f"sampling {len(sample)} real archives, {total_mb:.1f} MB total")

    red, green = fresh_target(), fresh_target()
    started = time.perf_counter()
    projected = 0
    findings = 0
    for row in sample:
        archive_id = int(row["id"])
        try:
            data = export_archive(live, archive_id)
        except (LookupError, ValueError, sqlite3.Error) as exc:
            print(f"  skip archive {archive_id}: {type(exc).__name__}")
            continue
        lines, trailing, ending = _split_source_lines(data)
        ref = f"probe://{archive_id}"
        for conn, prescan in ((red, None), (green, prescan_lines(lines))):
            conn.execute("BEGIN IMMEDIATE")
            result = ingest_lines(
                conn, source_ref=ref, session_ref=f"s{archive_id}",
                lines=lines, has_trailing_newline=trailing,
                line_ending=ending, now="2026-09-14T00:00:00Z",
                prescan=prescan,
            )
            conn.execute("COMMIT")
            if conn is green:
                findings += result.secret_findings
        projected += 1

    elapsed = time.perf_counter() - started
    print(f"projected {projected} archives both ways in {elapsed:.0f}s")
    print(f"secret findings recorded on the prescanned side: {findings}")

    red_digest, green_digest = content_digest(red), content_digest(green)
    differing = 0
    print(f"\n{'table':32} {'rows':>9}  content")
    for table in TABLES:
        r_hash, r_rows = red_digest[table]
        g_hash, g_rows = green_digest[table]
        same = r_hash == g_hash and r_rows == g_rows
        differing += 0 if same else 1
        verdict = "IDENTICAL" if same else (
            f"DIFFER  no-prescan={r_hash[:12]} prescan={g_hash[:12]}"
        )
        print(f"{table:32} {r_rows:>9,}  {verdict}")

    print()
    if not findings:
        print("NEGATIVE CONTROL FAILED: this sample carried no credentials, "
              "so an identical result proves nothing about the scan path.")
        return 2
    if differing:
        print(f"VERDICT: {differing} TABLE(S) DIFFER - the prescan changed "
              f"the rows, not just the lock hold.")
        return 1
    print("VERDICT: EVERY TABLE IDENTICAL, and the sample really did carry "
          "credentials.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
