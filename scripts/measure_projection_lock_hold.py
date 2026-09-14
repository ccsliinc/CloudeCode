"""How long does ONE fat transcript hold the archive's write lock?

Usage:
    ./venv/bin/python3 scripts/measure_projection_lock_hold.py [archive_id]

This is the RED/green harness for the projection budget defect. Run it
before and after any change to project_one's transaction, and compare the
LOCK-HOLD, not the pass duration.

THE PASS DURATION AND THE LOCK-HOLD ARE DIFFERENT NUMBERS and only the
second one strands every other writer. The projection slice's budget is
max_seconds=30, checked BETWEEN files and never inside one, so this is
the number the budget does not bound.

Read-only against the live archive; every write goes to a throwaway file.
"""
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.core.db import connect_archive_only  # noqa: E402
from src.core.db_steps import apply_message_model_schema  # noqa: E402
from src.core.message_body_codec import register_body_functions  # noqa: E402
from src.core.message_model_ingest import ingest_lines  # noqa: E402
from src.core.message_projection import _split_source_lines  # noqa: E402
from src.core.transcript_archive import export_archive  # noqa: E402

STATE = Path("/Users/jsugamele/Library/Application Support/CloudeCode")
ARCHIVE_ID = int(sys.argv[1]) if len(sys.argv) > 1 else 16874

live = connect_archive_only(STATE)
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

target = Path(tempfile.mkdtemp()) / "probe.db"
conn = sqlite3.connect(target, isolation_level=None, timeout=120)
conn.row_factory = sqlite3.Row
conn.execute("PRAGMA journal_mode=WAL")
conn.execute("PRAGMA foreign_keys=ON")
register_body_functions(conn)
apply_message_model_schema(conn)

start = time.perf_counter()
conn.execute("BEGIN IMMEDIATE")
lock_taken = time.perf_counter()
result = ingest_lines(
    conn, source_ref="probe://fat", session_ref="probe",
    lines=lines, has_trailing_newline=trailing,
    line_ending=ending, now="2026-09-14T00:00:00Z",
)
conn.execute("COMMIT")
held = time.perf_counter() - lock_taken

print()
print(f"  *** WRITE LOCK HELD {held:.1f} SECONDS for this ONE transcript ***")
print(f"      lines stored {result.line_count:,}, bodies created "
      f"{result.bodies_created:,}")
print(f"      the slice budget is 30 s, and it cannot interrupt this")
conn.close()
