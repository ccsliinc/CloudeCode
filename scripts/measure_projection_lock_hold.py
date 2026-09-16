"""How long does ONE fat transcript hold the archive's write lock?

Usage:
    ./venv/bin/python3 scripts/measure_projection_lock_hold.py [archive_id]

This is the RED/green harness for the projection budget defect. It runs
BOTH arms in ONE process against the SAME bytes, so the same machine and
the same load hit each of them:

    arm RED    ingest_lines with no prescan, which is what project_one
               did before issue 224 - the secret scan runs INSIDE the
               transaction
    arm GREEN  the prescan runs BEFORE BEGIN IMMEDIATE and the scan
               result is handed in, which is what project_one does now

THE PASS DURATION AND THE LOCK-HOLD ARE DIFFERENT NUMBERS and only the
second one strands every other writer. The projection slice's budget is
max_seconds=30, checked BETWEEN files and never inside one, so the
lock-hold is the number the budget does not bound. Both are printed and
they are labelled, because the fix deliberately makes the pass slightly
SLOWER (the body is rendered twice) in order to make the lock much
shorter.

CORRECTNESS IS ASSERTED, NOT ASSUMED. The two arms must produce the same
line count, the same bodies, and above all the SAME SECRET FINDINGS. A
fix that shortened the lock by quietly not recording findings would pass
every latency check and be a security regression, so this script fails
loudly on any disagreement.

Read-only against the live archive; every write goes to a throwaway file.
"""
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.core.db_steps import apply_message_model_schema  # noqa: E402
from src.core.message_body_codec import register_body_functions  # noqa: E402
from src.core.message_model_ingest import ingest_lines  # noqa: E402
from src.core.message_projection import _split_source_lines  # noqa: E402
from src.core.message_secret_prescan import prescan_lines  # noqa: E402
from src.core.transcript_archive import export_archive  # noqa: E402

STATE = Path("/Users/jsugamele/Library/Application Support/CloudeCode")
ARCHIVE_ID = int(sys.argv[1]) if len(sys.argv) > 1 else 16874

#: Read-only URI, because the live archive is never this script's to
#: write. A read-write handle on a 15 GB WAL database can checkpoint on
#: close, which is a write to a file nothing here has any business
#: changing.
_LIVE_URI = f"file:{STATE / 'cloude-archive.db'}?mode=ro"


def _fresh_target() -> sqlite3.Connection:
    """Open a throwaway message-model database for one arm.

    Description: a new file per arm, so neither arm can find the other's
      rows already interned and report a cheaper write than it made.
    Inputs: none.
    Output: sqlite3.Connection, schema applied, body functions registered.
    Example: _fresh_target().execute("SELECT 1")
    """
    target = Path(tempfile.mkdtemp()) / "probe.db"
    conn = sqlite3.connect(target, isolation_level=None, timeout=120)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    register_body_functions(conn)
    apply_message_model_schema(conn)
    return conn


def _findings_fingerprint(conn: sqlite3.Connection) -> list:
    """Every recorded secret finding, in a comparable, value-free shape.

    Description: joined back to the body's identity_key rather than its
      row id, because the two arms write independent databases and the
      row ids are not comparable. No matched value is read; the sha256
      the table already stores is what identifies a finding.
    Inputs: conn (sqlite3.Connection).
    Output: list of tuples, sorted.
    Example: _findings_fingerprint(conn)[:1]
    """
    return sorted(
        tuple(row) for row in conn.execute(
            "SELECT b.identity_key, f.detector, f.match_offset, "
            "       f.match_length, f.value_sha256 "
            "  FROM message_secret_findings f "
            "  JOIN message_bodies b ON b.id = f.body_id"
        )
    )


live = sqlite3.connect(_LIVE_URI, uri=True)
live.row_factory = sqlite3.Row
t0 = time.perf_counter()
data = export_archive(live, ARCHIVE_ID)
export_s = time.perf_counter() - t0
t0 = time.perf_counter()
lines, trailing, ending = _split_source_lines(data)
split_s = time.perf_counter() - t0
live.close()

print(f"  archive {ARCHIVE_ID}: {len(data)/1e6:.1f} MB, {len(lines):,} lines")
print(f"  export_archive       {export_s*1000:9.1f} ms   already OUTSIDE the transaction")
print(f"  _split_source_lines  {split_s*1000:9.1f} ms   already OUTSIDE the transaction")

results = {}
for arm in ("RED", "GREEN"):
    conn = _fresh_target()
    pass_started = time.perf_counter()
    prescan = None
    prescan_s = 0.0
    if arm == "GREEN":
        t0 = time.perf_counter()
        prescan = prescan_lines(lines)
        prescan_s = time.perf_counter() - t0
    conn.execute("BEGIN IMMEDIATE")
    lock_taken = time.perf_counter()
    result = ingest_lines(
        conn, source_ref="probe://fat", session_ref="probe",
        lines=lines, has_trailing_newline=trailing,
        line_ending=ending, now="2026-09-14T00:00:00Z",
        prescan=prescan,
    )
    conn.execute("COMMIT")
    held = time.perf_counter() - lock_taken
    total = time.perf_counter() - pass_started
    results[arm] = {
        "held": held, "total": total, "prescan_s": prescan_s,
        "lines": result.line_count, "bodies": result.bodies_created,
        "secret_findings": result.secret_findings,
        "fingerprint": _findings_fingerprint(conn),
        "stored_bodies": conn.execute(
            "SELECT COUNT(*) FROM message_bodies").fetchone()[0],
        "flagged": conn.execute(
            "SELECT COUNT(*) FROM message_bodies "
            "WHERE secret_finding_count > 0").fetchone()[0],
    }
    print()
    print(f"  --- arm {arm} ---")
    if arm == "GREEN":
        print(f"      prescan (OUTSIDE the lock) {prescan_s:8.1f} s, "
              f"{len(prescan):,} bodies measured")
    print(f"  *** WRITE LOCK HELD {held:.1f} SECONDS for this ONE transcript ***")
    print(f"      whole pass {total:.1f} s   lines {result.line_count:,}   "
          f"bodies created {result.bodies_created:,}   "
          f"secret findings {result.secret_findings:,}")
    conn.close()

red, green = results["RED"], results["GREEN"]
print()
print("  ================ RESULT ================")
print(f"  lock hold   RED {red['held']:8.1f} s -> GREEN {green['held']:8.1f} s"
      f"   ({red['held']/green['held']:.1f}x shorter)")
print(f"  pass total  RED {red['total']:8.1f} s -> GREEN {green['total']:8.1f} s"
      f"   (the prescan is real work, moved, not removed)")
print(f"  the slice budget is 30 s, and it cannot interrupt the lock")

problems = []
for field in ("lines", "bodies", "secret_findings", "stored_bodies", "flagged"):
    if red[field] != green[field]:
        problems.append(f"{field}: RED {red[field]} != GREEN {green[field]}")
if red["fingerprint"] != green["fingerprint"]:
    problems.append(
        f"secret finding rows differ: RED {len(red['fingerprint'])} rows, "
        f"GREEN {len(green['fingerprint'])} rows, "
        f"{len(set(red['fingerprint']) ^ set(green['fingerprint']))} not in both"
    )
print()
if problems:
    print("  CORRECTNESS FAILED - the arms do not agree:")
    for line in problems:
        print(f"    {line}")
    raise SystemExit(1)
print(f"  correctness: the two arms agree exactly, including all "
      f"{len(red['fingerprint']):,} secret finding rows")
