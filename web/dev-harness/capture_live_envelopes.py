#!/usr/bin/env python3
"""Capture what each project-list route really returns, for nav-views.html.

WHY A CAPTURE AND NOT A FIXTURE. A fixture is composed by the person
doing the verifying, and a fixture that happens to carry
``app_name_source`` is how a screen showing slugs passes a naming test -
which is exactly what happened four times here. This calls each ROUTE'S
OWN BODY against the real databases and writes the envelopes verbatim,
so the harness page replays the server's bytes rather than anybody's
idea of them.

WHY THE ROUTE BODY AND NOT AN HTTP REQUEST. The API needs a TOTP code.
Running the handlers' own helpers in-process reaches the same envelopes
with no credential, read-only, which is what makes this re-runnable by
an agent that cannot log in.

WHAT IT PROVES AND WHAT IT DOES NOT. It proves what the routes produce.
It does NOT prove an authenticated browser session receives the same
bytes over HTTP; only somebody who can log in can confirm that half.

The output is the owner's real project paths, so it is deliberately NOT
committed. Run this once per machine before opening nav-views.html.

Usage:
    CLOUDE_STATE_DIR=~/Library/Application\\ Support/CloudeCode \\
    DEFAULT_WORKING_DIR=~/Development LOG_DIRECTORY=/tmp/cloude-probe \\
    TOTP_SECRET=AAAAAAAAAAAAAAAA JWT_SECRET=probe-only-not-a-real-secret \\
    venv/bin/python3 web/dev-harness/capture_live_envelopes.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

#: The repository root, two levels up from this file.
ROOT = Path(__file__).resolve().parents[2]

#: Where the harness page fetches the capture from.
OUT = Path(__file__).resolve().parent / "live-envelopes.json"


def main() -> int:
    """Write the capture.

    Output: int - 0 on success.
    """
    sys.path.insert(0, str(ROOT))
    os.chdir(ROOT)

    from src.api import archive_overlay_routes, archive_routes
    from src.api.archive_support import state_dir
    from src.core import archive_hierarchy, archive_merged_tree
    from src.core.archive_read import run_read

    sd = state_dir()

    # `/archive/projects` - the ONLY project route that is decorated,
    # and the one no view reads.
    named = archive_routes._name_projects(run_read(
        sd, archive_merged_tree.merged_projects,
        subject="archive:projects", unreadable_result=None,
    ))
    # `/archive/overlay/projects` - what the MERGED view lists.
    overlay = run_read(
        sd, archive_overlay_routes._presented, subject="archive:overlay",
        unreadable_result=None, include_hidden=False, hidden_only=False,
    )
    hosts = run_read(sd, archive_hierarchy.hosts, subject="hosts",
                     unreadable_result=None)

    corpora: dict = {}
    projects: dict = {}
    for host in hosts["result"]:
        listing = run_read(sd, archive_hierarchy.corpora_for_host,
                           host["host_id"], subject="c", unreadable_result=None)
        corpora[str(host["host_id"])] = listing
        for row in listing["result"]:
            # `/archive/corpora/{id}/projects` - the BY-MACHINE view's
            # project level, also undecorated.
            projects[str(row["corpus_id"])] = run_read(
                sd, archive_hierarchy.projects_for_corpus, row["corpus_id"],
                subject="p", unreadable_result=None, limit=200, cursor=None,
            )

    OUT.write_text(json.dumps({
        "named": named, "overlay": overlay, "hosts": hosts,
        "corpora": corpora, "projects": projects,
    }, default=str))

    def carrying(env: dict) -> int:
        """How many rows carry an app_name_source at all."""
        return sum(1 for r in env.get("result") or [] if "app_name_source" in r)

    print(f"wrote {OUT}")
    print(f"  /archive/projects          rows={len(named['result'])} "
          f"carrying app_name_source={carrying(named)}")
    print(f"  /archive/overlay/projects  rows={len(overlay['result'])} "
          f"carrying app_name_source={carrying(overlay)}")
    for cid, env in projects.items():
        print(f"  /archive/corpora/{cid}/projects rows={len(env['result'])} "
              f"carrying app_name_source={carrying(env)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
