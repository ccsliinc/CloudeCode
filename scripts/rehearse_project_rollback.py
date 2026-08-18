#!/usr/bin/env python3
"""Rehearse the project rollback against a COPY of a real install.

Description: walks the whole authority-inversion lifecycle end to end -
  migrate, snapshot, mutate, delete the database, come back up - and
  prints what happened at each step. Written as a script rather than left
  as an ad-hoc shell heredoc so the rehearsal is repeatable by the next
  person and its result is reproducible rather than a transcript.

  READ-ONLY WITH RESPECT TO THE REAL INSTALL. It operates entirely inside
  the directory it is given, which the caller has already populated with
  COPIES (``sqlite3 .backup``, never ``cp``, for the database). It never
  reads or writes the live state directory or the live config.json.

Inputs: argv[1] (str) - a working directory containing ``state/cloude.db``
  and ``config.json``, both copies.
Output: None. Prints a step-by-step report; exits non-zero if any
  load-bearing assertion of the rollback design does not hold.
Example: ./venv/bin/python3 scripts/rehearse_project_rollback.py /tmp/reh
"""

from __future__ import annotations

import json
import os
import sys
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from typing import List

os.environ.setdefault("DEFAULT_WORKING_DIR", "/tmp")
os.environ.setdefault("LOG_DIRECTORY", "/tmp")
os.environ.setdefault("TOTP_SECRET", "rehearsalnotreal")
os.environ.setdefault("JWT_SECRET", "rehearsalnotreal")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# ruff: noqa: E402
from src.core.db import connect, db_path_for, get_meta
from src.core.db_migration import ensure_db_migrated
from src.core.db_models import META_IMPORTED_FROM_JSON_AT
from src.core.project_authority import refresh_snapshot, resolve_projects
from src.core.project_store import import_from_config
from src.core.project_writes import (
    create_project,
    list_projects_ordered,
    resolve_by_name,
    update_project,
)

FAILURES: List[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    """Print one named assertion and record it if it did not hold.

    Inputs: label (str) - what was checked. condition (bool) - the result.
      detail (str) - extra context printed alongside.
    Output: None.
    """
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {label}{(' - ' + detail) if detail else ''}")
    if not condition:
        FAILURES.append(label)


def main(work_dir: Path) -> int:
    """Run the rehearsal and return a process exit code.

    Inputs: work_dir (Path) - holds ``state/cloude.db`` and ``config.json``.
    Output: int - 0 when every step held, 1 otherwise.
    """
    state = work_dir / "state"
    config_file = work_dir / "config.json"

    def config_projects() -> List[SimpleNamespace]:
        """Read the rehearsal config.json as ProjectConfig-like objects.

        Inputs: none (closes over config_file).
        Output: list[SimpleNamespace].
        """
        doc = json.loads(config_file.read_text())
        return [
            SimpleNamespace(
                name=p["name"],
                path=p["path"],
                description=p.get("description"),
                agent_type=p.get("agent_type"),
            )
            for p in doc["projects"]
        ]

    print("STEP 1  the install as it stands")
    print(f"  config.json entries: {len(config_projects())}")
    state_verdict = ensure_db_migrated(state, 4, "0.8.2")
    check(
        "schema migrated cleanly",
        state_verdict.status == "ok",
        f"{state_verdict.status}, applied {state_verdict.migrations_applied}",
    )
    check(
        "a populated migration took a backup",
        bool(state_verdict.backup_path),
        str(state_verdict.backup_path),
    )

    view = resolve_projects(state, config_projects())
    check("mode is db", view.mode == "db", view.mode)
    check("writes allowed", view.writable is True)
    print(f"  projects served: {len(view.projects)}")
    check(
        "the two sources agree",
        view.diff is not None and view.diff.agree,
    )
    check(
        "duplicate config roots are reported separately",
        view.diff is not None and len(view.diff.duplicate_config_roots) > 0,
        f"{len(view.diff.duplicate_config_roots)} duplicated roots noted",
    )

    print("\nSTEP 2  snapshot config.json from the authoritative table")
    result = refresh_snapshot(state, config_file)
    check("snapshot written", result.ok, result.reason)
    print(f"  entries written: {result.written}")
    doc = json.loads(config_file.read_text())
    check("other config keys preserved", "notifications" in doc)
    paths = [p["path"] for p in doc["projects"]]
    check("no duplicate paths in the snapshot", len(paths) == len(set(paths)))

    print("\nSTEP 3  mutate through the authoritative write path")
    with closing(connect(db_path_for(state))) as conn:
        create_project(
            conn, name="rehearsal-project", path="/tmp/rehearsal-project"
        )
        target = resolve_by_name(conn, "CloudeCode")
        update_project(conn, target["id"], new_name="Cloude Code HQ")
    refresh_snapshot(state, config_file)
    names = [p["name"] for p in json.loads(config_file.read_text())["projects"]]
    check("the create reached config.json", "rehearsal-project" in names)
    check("the rename reached config.json", "Cloude Code HQ" in names)
    check("the old name is gone from config.json", "CloudeCode" not in names)

    print("\nSTEP 4  THE REVERT - delete cloude.db")
    db_path_for(state).unlink()
    view = resolve_projects(state, config_projects())
    check("degraded to config fallback", view.mode == "config_fallback", view.mode)
    check("writes refused while degraded", view.writable is False)
    check("projects still shown", len(view.projects) > 0, f"{len(view.projects)}")
    check("no diff invented while blind", view.diff is None)
    before = config_file.read_text()
    check("snapshot refused while degraded", not refresh_snapshot(state, config_file).ok)
    check("config.json left untouched", config_file.read_text() == before)

    print("\nSTEP 5  reboot from nothing")
    ensure_db_migrated(state, 4, "0.8.2")
    with closing(connect(db_path_for(state))) as conn:
        check(
            "the import latch went with the file",
            get_meta(conn, META_IMPORTED_FROM_JSON_AT) is None,
        )
        with conn:
            import_from_config(conn, config_projects())
        rows = list_projects_ordered(conn)

    recovered = [r["display_name"] for r in rows]
    print(f"  projects recovered: {len(rows)}")
    print(f"  order: {recovered}")
    check("the pre-revert create survived", "rehearsal-project" in recovered)
    check("the pre-revert rename survived", "Cloude Code HQ" in recovered)
    roots = [r["root"] for r in rows]
    check("no duplicate roots resurrected", len(roots) == len(set(roots)))

    view = resolve_projects(state, config_projects())
    check("fully writable again", view.mode == "db" and view.writable)
    check("sources agree after the revert", view.diff is not None and view.diff.agree)

    print()
    if FAILURES:
        print(f"REHEARSAL FAILED - {len(FAILURES)} check(s) did not hold:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("REHEARSAL PASSED - every step of the rollback held")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1])))
