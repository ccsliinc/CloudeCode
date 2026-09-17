#!/usr/bin/env python3
"""Prove :mod:`verify_all_conversations` can FAIL, before a green run is trusted.

WHY THIS IS A SEPARATE FILE AND NOT A TEST. It ships with the script and runs
from the same command the owner runs (``--self-test``), because the person who
most needs to see the negative controls go red is the person about to believe a
green answer, standing at a terminal, with no pytest.

THE POSITIVE CONTROL IS WORTHLESS ON ITS OWN. A function that returned
"all accounted for" unconditionally passes it perfectly. Every other control
here exists to make that function fail, and the suite was itself mutation
tested: emptying the gap list was caught, and that mutation ALSO exposed a real
defect in the script (the printed verdict and the exit code were derived from
two different values, so the mutant printed GAP and exited 0). Control 5 pins
that shut.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from typing import List, Sequence

from verify_all_conversations import (DISPOSITION_ACCEPTED, DISPOSITION_OPEN,
                                      EXIT_CANNOT_EVALUATE, EXIT_GAP, EXIT_OK,
                                      evaluate, exit_code_for)

def _write_archive(path: str, source_paths: Sequence[str]) -> None:
    """Build a throwaway archive database holding the given source paths.

    Inputs:
      path: file to create.
      source_paths: values for ``transcript_archives.source_path``.
    Outputs:
      None.
    """
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE transcript_archives "
                 "(id INTEGER PRIMARY KEY, source_path TEXT NOT NULL)")
    conn.executemany("INSERT INTO transcript_archives (source_path) VALUES (?)",
                     [(p,) for p in source_paths])
    conn.commit()
    conn.close()


def _write_corpus(root: str, source_paths: Sequence[str]) -> None:
    """Materialise a throwaway corpus tree.

    Inputs:
      root: directory to create files under.
      source_paths: relative ``slug/stem.jsonl`` paths.
    Outputs:
      None.
    """
    for rel in source_paths:
        full = os.path.join(root, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as handle:
            handle.write("{}\n")


def self_test() -> int:
    """Prove this checker can fail before anyone trusts it passing.

    Five controls. The positive control alone is worthless: a function that
    returned ``all_accounted_for`` unconditionally would pass it. The four
    negatives are what make a green run mean something.

    Outputs:
      int: 0 when every control behaved, 1 when any did not.
    """
    failures: List[str] = []

    def check(label: str, got: str, want: str) -> None:
        ok = got == want
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}: got {got}, want {want}")
        if not ok:
            failures.append(label)

    with tempfile.TemporaryDirectory() as tmp:
        arc = os.path.join(tmp, "archive.db")
        root = os.path.join(tmp, "corpus")
        cen = os.path.join(tmp, "census.json")
        live = ["proj/aaaa.jsonl", "proj/bbbb.jsonl",
                "proj/aaaa/subagents/agent-1111.jsonl"]
        _write_archive(arc, live)
        _write_corpus(root, live)
        census = {
            "sources": [{"name": "fake nas tarball",
                         "conversation_stems_missing_from_live": []}],
            "conversations": {}, "subagents": {},
        }
        with open(cen, "w", encoding="utf-8") as handle:
            json.dump(census, handle)

        print("positive control (complete set):")
        check("complete set is all_accounted_for",
              evaluate(arc, root, cen)["verdict"], "all_accounted_for")

        print("negative control 1 (a conversation on disk is not in the archive):")
        short = os.path.join(tmp, "archive_short.db")
        _write_archive(short, live[:1] + live[2:])
        rep = evaluate(short, root, cen)
        check("missing conversation is a gap", rep["verdict"], "gap")
        named = [g["stem"] for g in rep["open_gaps"]]
        check("the gap names the right stem", str(named), "['bbbb']")

        print("negative control 2 (the census names a conversation the archive lacks):")
        cen2 = os.path.join(tmp, "census2.json")
        census2 = {
            "sources": [{"name": "fake nas tarball",
                         "conversation_stems_missing_from_live": ["cccc"]}],
            "conversations": {"cccc": {"sources": ["fake nas tarball"],
                                       "disposition": DISPOSITION_OPEN}},
            "subagents": {},
        }
        with open(cen2, "w", encoding="utf-8") as handle:
            json.dump(census2, handle)
        rep2 = evaluate(arc, root, cen2)
        check("census-only conversation is a gap", rep2["verdict"], "gap")
        check("it is counted in the ever total",
              str(rep2["total_conversations_ever"]), "3")

        print("negative control 3 (an accepted gap does not fail, and is still listed):")
        cen3 = os.path.join(tmp, "census3.json")
        census3 = json.loads(json.dumps(census2))
        census3["conversations"]["cccc"]["disposition"] = DISPOSITION_ACCEPTED
        census3["conversations"]["cccc"]["reason"] = "owner accepted, test"
        with open(cen3, "w", encoding="utf-8") as handle:
            json.dump(census3, handle)
        rep3 = evaluate(arc, root, cen3)
        check("accepted gap passes", rep3["verdict"], "all_accounted_for")
        check("accepted gap is still listed",
              str(len(rep3["accepted_gaps"])), "1")

        print("negative control 4 (nothing readable is NOT a pass):")
        check("missing archive is cannot_evaluate",
              evaluate(os.path.join(tmp, "nope.db"), root, cen)["verdict"],
              "cannot_evaluate")
        check("missing census is cannot_evaluate",
              evaluate(arc, root, os.path.join(tmp, "nope.json"))["verdict"],
              "cannot_evaluate")
        bad = os.path.join(tmp, "bad.json")
        with open(bad, "w", encoding="utf-8") as handle:
            handle.write("{not json")
        check("unparseable census is cannot_evaluate",
              evaluate(arc, root, bad)["verdict"], "cannot_evaluate")
        check("unreadable corpus root is cannot_evaluate",
              evaluate(arc, os.path.join(tmp, "nope"), cen)["verdict"],
              "cannot_evaluate")

        print("negative control 5 (the exit code can never disagree with the "
              "printed verdict):")
        for verdict, want in (("all_accounted_for", EXIT_OK),
                              ("gap", EXIT_GAP),
                              ("cannot_evaluate", EXIT_CANNOT_EVALUATE),
                              ("something_nobody_wrote", EXIT_CANNOT_EVALUATE)):
            check(f"exit code for {verdict}",
                  str(exit_code_for(verdict)), str(want))
        gap_report = evaluate(short, root, cen)
        check("a gap report exits non-zero",
              str(exit_code_for(gap_report["verdict"])), str(EXIT_GAP))

    if failures:
        print(f"\nSELF-TEST FAILED: {len(failures)} control(s) misbehaved: "
              f"{failures}")
        return 1
    print("\nSELF-TEST PASSED: every negative control produced a non-zero "
          "verdict, so a green run means something.")
    return 0


if __name__ == "__main__":
    raise SystemExit(self_test())
