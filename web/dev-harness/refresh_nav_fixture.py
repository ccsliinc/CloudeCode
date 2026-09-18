#!/usr/bin/env python3
"""Refresh the naming fields on `nav-real-nodes.fixture.json` from live.

WHY THIS EXISTS AS A SCRIPT. The parity page and eight vitest suites are
fed one captured file of 98 real merged project nodes. The server grew
four new fields on those nodes (``app_name_source`` gained three values,
and ``app_name_evidence`` / ``app_name_cwd`` /
``app_name_anchor_project_id`` arrived), and a fixture that does not
carry them measures a client against a shape the server no longer sends.
Hand-editing 98 rows is how a fixture stops being real data.

IT UPDATES THE NAMING FIELDS AND NOTHING ELSE, WHICH IS THE WHOLE
DESIGN. Every density number this rail has been tuned against - the
49px card, the zero truncated counts runs at 320px, the ordering parity
over 98 rows - was measured on this population with these counts and
these dates. Re-capturing the listing wholesale would silently move all
of them, and a later disagreement would be unattributable. So the
existing rows are read, matched on ``full_path``, and only the naming
keys are written. A slug present in one and not the other is REPORTED
and refused rather than reconciled: the fixture's population is a fixed
reference set, and quietly adding or dropping a row is exactly the drift
this refuses to perform.

IT RUNS THE SERVER'S OWN PIPELINE, not a re-implementation of it. The
three calls below are the three ``src/api/archive_routes.py`` makes, in
that order, so a fixture refreshed here cannot disagree with what the
route would answer. Read-only: no write is issued to either database.

Usage:
    venv/bin/python3 web/dev-harness/refresh_nav_fixture.py [--write]

Dry run by default. It prints the outcome counts either way.
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import sys
from typing import Dict, List

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

#: The captured listing the parity page and the vitest suites read.
FIXTURE = (REPO_ROOT / "web/src/lib/plugins/history"
           / "nav-real-nodes.fixture.json")

#: Exactly the keys this script is allowed to write. Anything else on a
#: node belongs to the capture and is left alone.
NAMING_KEYS = (
    "app_display_name",
    "app_description",
    "app_name_source",
    "app_project_id",
    "app_name_evidence",
    "app_name_cwd",
    "app_name_anchor_project_id",
)


def state_dir() -> pathlib.Path:
    """Where the app keeps ``cloude.db`` and ``cloude-archive.db``.

    Description: the default location from
      :mod:`src.config.state_paths`, resolved without importing the
      whole ``Settings`` object - which needs a ``.env`` this script has
      no business requiring for a read.
    Inputs: none. Output: pathlib.Path.
    """
    return pathlib.Path.home() / "Library" / "Application Support" / "CloudeCode"


def live_nodes() -> Dict[str, dict]:
    """Run the route's own naming pipeline and key the result by slug.

    Description: the same three calls ``_name_projects`` makes, in the
      same order, against the real databases. Read-only.
    Inputs: none.
    Output: dict[str, dict] - slug to decorated node.
    """
    from src.core import archive_merged_tree, archive_name_decorate
    from src.core.app_name_index import load_app_name_index
    from src.core.archive_cwd_evidence import load_archive_cwd_index
    from src.core.archive_read import run_read

    where = state_dir()
    envelope = run_read(
        where, archive_merged_tree.merged_projects,
        subject="archive:projects", unreadable_result=None,
    )
    index = load_app_name_index(where)
    envelope = archive_name_decorate.decorate_project_nodes(envelope, index)
    unnamed = archive_name_decorate.unnamed_slugs(envelope)
    envelope = archive_name_decorate.decorate_project_nodes_from_cwd(
        envelope, index, load_archive_cwd_index(where, unnamed),
    )
    nodes = envelope.get("result") or []
    return {node["full_path"]: node for node in nodes if node.get("full_path")}


def main() -> int:
    """Refresh the fixture's naming fields, or report what would change.

    Output: int - 0 on success, 2 when the populations disagree.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true",
                        help="write the file. Dry run without it.")
    args = parser.parse_args()

    rows: List[dict] = json.loads(FIXTURE.read_text())
    live = live_nodes()
    missing = [row["full_path"] for row in rows if row["full_path"] not in live]
    if missing:
        print(f"REFUSED: {len(missing)} fixture slugs are absent from the live "
              f"listing, so this is not the same population: {missing[:5]}")
        return 2

    counts: collections.Counter = collections.Counter()
    for row in rows:
        node = live[row["full_path"]]
        for key in NAMING_KEYS:
            row[key] = node.get(key)
        counts[row["app_name_source"]] += 1

    print(f"{len(rows)} rows, {len(live)} live "
          f"({len(live) - len(rows)} live rows not in this fixture)")
    for kind, n in sorted(counts.items()):
        print(f"  {kind:20s} {n}")
    if args.write:
        # Indent 1 and escaped non-ASCII, matching the capture byte
        # for byte outside the fields this touches. A reformat would
        # make every future diff of this file unreadable.
        FIXTURE.write_text(json.dumps(rows, indent=1) + "\n")
        print(f"wrote {FIXTURE}")
    else:
        print("dry run. pass --write to save.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
