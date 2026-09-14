#!/usr/bin/env python3
"""Refuse the corpus drain unless the split datastore is in a safe shape.

WHY THIS EXISTS. The drain writes millions of rows into the message model,
which after the split lives in ``cloude-archive.db``. Every one of those
writes names its table WITHOUT a schema prefix, because SQLite resolves a
bare table name across attached databases and that is what keeps 68 call
sites unchanged. The resolution has one rule: MAIN WINS. So a table present
in BOTH files sends every unqualified write to ``cloude.db`` while the
reader that expects the archive sees nothing, and neither side raises.

That is the failure this file exists to catch, and it is not hypothetical:
``message_projection_ledger`` was created in ``cloude.db`` by a build whose
``ensure_ledger`` issued an unqualified CREATE, and the live server then
recorded a projection there while the rows it described went into the
archive.

Gate 0 additionally proves the DEPLOYED tree carries the fix, because the
running server is a copied directory and not this checkout, so a fix that
is committed here says nothing about what is executing there.

Usage:
    ./venv/bin/python3 scripts/drain_preflight.py

Exit codes:
    0  every gate passed; the drain may start
    1  at least one gate refused; the reason is printed and the drain
       must NOT start
"""
from __future__ import annotations

import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.core.archive_db_attach import (  # noqa: E402
    archive_sibling_for,
    attach_archive,
    shadowed_tables,
    which_database,
)

#: The live install's state directory. The drain only ever runs against it.
STATE_DIR = Path("/Users/jsugamele/Library/Application Support/CloudeCode")

#: The deployed server directory, which is a COPY of a checkout and is what
#: actually executes. Hashing this is the only way to know what is running.
DEPLOYED_DIR = Path(
    "/Users/jsugamele/Library/Application Support/cloude-code-menubar/server"
)

#: Source markers proving the deployed tree carries the archive-aware reads.
#: Each pair is (path relative to a tree root, identifier that must appear).
DEPLOY_MARKERS = (
    ("src/core/db.py", "which_database"),
    ("src/core/message_projection_ledger.py", "execute_archive_ddl"),
)

#: Tables that must resolve to exactly one file. The message model and the
#: transcript archive are archive-side; a copy in main shadows them.
SINGLE_FILE_TABLES = (
    "message_projection_ledger",
    "transcript_archives",
    "transcript_records",
    "message_transcripts",
    "message_bodies",
    "message_content_blocks",
    "message_appearances",
)

#: Extrapolated growth of a full drain, in GiB. Derived from a 300 archive
#: sample, NOT measured over the whole corpus, and named here so the margin
#: below is honest about what it rests on.
PROJECTED_GROWTH_GIB = 15.6

#: Free space that must remain AFTER the projected growth.
REQUIRED_MARGIN_GIB = 5.0

#: Live tmux sessions expected on the `cloude` socket.
EXPECTED_SESSIONS = 19

#: The environment variable that switches the SERVER's own budgeted
#: projection pass off. message_projection_report.projection_enabled
#: reads it per pass and documents itself as "the knob an operator wants
#: when a backfill is running from a script"; this gate is what makes
#: sure the operator actually turns it.
PROJECTION_ENV = "CLOUDE_MESSAGE_PROJECTION"

#: Values that mean off. Anything else, including absent, means ON.
PROJECTION_OFF_VALUES = frozenset({"0", "false", "no", "off"})


def open_readonly(path: Path) -> sqlite3.Connection:
    """Open a database read-only so a gate can never write to it.

    Inputs: path (Path) - the database file.
    Output: sqlite3.Connection.
    Example: open_readonly(STATE_DIR / "cloude.db")
    """
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def gate_deployed_build(failures: List[str]) -> None:
    """Refuse unless the RUNNING tree carries the archive-aware reads.

    Inputs: failures (list) - appended to on refusal.
    Output: None.
    Example: gate_deployed_build([])
    """
    print("=== GATE 0: the deployed tree carries the fix ===")
    for rel, marker in DEPLOY_MARKERS:
        target = DEPLOYED_DIR / rel
        if not target.exists():
            print(f"  {rel}: MISSING from the deployed tree")
            failures.append(f"deployed tree has no {rel}")
            continue
        hits = target.read_text().count(marker)
        print(f"  {rel}: {marker} x{hits}")
        if hits < 1:
            failures.append(f"deployed {rel} does not mention {marker}")


def gate_no_shadowing(failures: List[str]) -> sqlite3.Connection:
    """Refuse on ANY table present in both files, and name it.

    Inputs: failures (list) - appended to on refusal.
    Output: sqlite3.Connection - the attached read-only pair, for reuse.
    Example: gate_no_shadowing([])
    """
    print("=== GATE 1: shadowing must be ZERO ===")
    main_db = STATE_DIR / "cloude.db"
    archive_db = archive_sibling_for(main_db)
    conn = open_readonly(main_db)
    attached = attach_archive(conn, main_db)
    print(f"  archive attached: {attached} ({archive_db})")
    if not attached:
        failures.append("the archive could not be attached")
        return conn

    shadow = shadowed_tables(conn)
    print(f"  SHADOWED: {len(shadow)} {shadow}")
    if shadow:
        failures.append(f"shadowed tables: {shadow}")

    print("  -- each of these must live in exactly one file --")
    main_side = open_readonly(main_db)
    arch_side = open_readonly(archive_db)
    for name in SINGLE_FILE_TABLES:
        in_main = main_side.execute(
            "SELECT count(*) FROM main.sqlite_master WHERE name = ?", (name,)
        ).fetchone()[0]
        in_arch = arch_side.execute(
            "SELECT count(*) FROM main.sqlite_master WHERE name = ?", (name,)
        ).fetchone()[0]
        resolved = which_database(conn, name)
        both = "   <-- PRESENT IN BOTH" if in_main + in_arch > 1 else ""
        print(
            f"  {name:28s} main={in_main} archive={in_arch} "
            f"resolves->{resolved}{both}"
        )
        if in_main + in_arch > 1:
            failures.append(f"{name} is present in both files")
    return conn


def gate_disk(failures: List[str]) -> None:
    """Refuse unless the projected growth leaves a real margin.

    Inputs: failures (list) - appended to on refusal.
    Output: None.
    Example: gate_disk([])
    """
    print("=== GATE 2: disk ===")
    free_gib = shutil.disk_usage(STATE_DIR).free / 1024 ** 3
    margin = free_gib - PROJECTED_GROWTH_GIB
    print(
        f"  free {free_gib:.1f} GiB, projected growth {PROJECTED_GROWTH_GIB} "
        f"GiB (an extrapolation), margin {margin:.1f} GiB"
    )
    if margin < REQUIRED_MARGIN_GIB:
        failures.append(f"disk margin {margin:.1f} GiB is under the floor")


def gate_live_healthy(failures: List[str]) -> None:
    """Refuse unless the live server answers and its sessions are intact.

    Inputs: failures (list) - appended to on refusal.
    Output: None.
    Example: gate_live_healthy([])
    """
    print("=== GATE 3: live is healthy ===")
    code = subprocess.run(
        [
            "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
            "--max-time", "20", "http://127.0.0.1:8000/health",
        ],
        capture_output=True, text=True,
    ).stdout.strip()
    sessions = subprocess.run(
        ["/opt/homebrew/bin/tmux", "-L", "cloude", "list-sessions"],
        capture_output=True, text=True,
    ).stdout.strip().splitlines()
    print(f"  health HTTP {code}, tmux sessions: {len(sessions)}")
    if code != "200":
        failures.append(f"health answered {code}")
    if len(sessions) != EXPECTED_SESSIONS:
        failures.append(
            f"{len(sessions)} tmux sessions, expected {EXPECTED_SESSIONS}"
        )



def server_projection_state() -> tuple:
    """Say whether the RUNNING server still projects, and how that was learned.

    Description: reads the listening process's OWN environment rather
      than a config file or an assumption, because the switch is read
      from ``os.environ`` on every pass and only the process can say what
      it inherited. No server listening is reported separately from a
      server whose setting could not be read: the first is safe (nothing
      to contend with) and the second is not.
    Inputs: none.
    Output: tuple[str, str] - (state, detail) where state is "off",
      "on", "no_server" or "cannot_determine".
    Example: server_projection_state()[0] -> 'off'
    """
    pid = subprocess.run(
        ["lsof", "-nP", "-iTCP:8000", "-sTCP:LISTEN", "-t"],
        capture_output=True, text=True,
    ).stdout.split()
    if not pid:
        return ("no_server", "nothing is listening on :8000")
    proc = subprocess.run(
        ["ps", "-Eww", "-p", pid[0]], capture_output=True, text=True,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return ("cannot_determine",
                f"the environment of pid {pid[0]} could not be read")
    for token in proc.stdout.split():
        if token.startswith(PROJECTION_ENV + "="):
            value = token.split("=", 1)[1].strip().lower()
            if value in PROJECTION_OFF_VALUES:
                return ("off", f"pid {pid[0]} has {PROJECTION_ENV}={value!r}")
            return ("on", f"pid {pid[0]} has {PROJECTION_ENV}={value!r}")
    return ("on", f"pid {pid[0]} does not set {PROJECTION_ENV}, which "
                  f"defaults the projection pass ON")


def gate_server_projection_off(failures: List[str]) -> None:
    """Refuse while the server would project into the archive too.

    Description: TWO PROJECTORS RACE, AND THE DRAIN LOSES. Both select
      the same pending head of the same queue and both take the
      archive's write lock; measured 2026-09-14, the drain sat on
      ``BEGIN IMMEDIATE`` for 7.5 MINUTES behind one server slice, and
      the server's passes reported ``replaced`` counts of 12, 32 and 18
      - transcripts one projector redoing what the other had just done.

      That is WASTE, NOT CORRUPTION: ``message_transcripts.source_ref``
      is UNIQUE and ``message_appearances`` cascades on delete, so
      re-projecting a transcript replaces it cleanly and cannot
      double-count a row.

      THE KNOB MUST BE TURNED BEFORE THE RUN, NOT DURING IT. It is read
      from the environment on every pass, so changing it needs the
      server restarted - which is exactly what nobody wants to do to a
      drain already in flight. A comment in a runbook is not read at
      3am; this refuses to start.
    Inputs: failures (list) - appended to on refusal.
    Output: None.
    Example: gate_server_projection_off([])
    """
    print("=== GATE 4: the server's own projector must be OFF ===")
    state, detail = server_projection_state()
    print(f"  {state}: {detail}")
    if state == "off" or state == "no_server":
        return
    failures.append(
        f"the live server would project too ({detail}). Set "
        f"{PROJECTION_ENV}=0 in its environment and restart it BEFORE "
        f"starting the drain, then re-enable it afterwards."
    )

def main() -> int:
    """Run every gate and report, refusing on the first thing that is wrong.

    Inputs: none.
    Output: int - process exit code.
    Example: raise SystemExit(main())
    """
    failures: List[str] = []
    gate_deployed_build(failures)
    gate_no_shadowing(failures)
    gate_disk(failures)
    gate_live_healthy(failures)
    gate_server_projection_off(failures)

    print()
    if failures:
        print("STOP. The drain must not start:")
        for reason in failures:
            print(f"  - {reason}")
        return 1
    print("ALL GATES PASS. The drain may start.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
