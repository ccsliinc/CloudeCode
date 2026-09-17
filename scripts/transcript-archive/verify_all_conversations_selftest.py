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

CONTROLS 6 TO 11 COVER THE SECOND POPULATION, ADDED 2026-09-17 when the owner
put subagent runs in scope. Each was watched RED before it was trusted, against
the code as it stood BEFORE the change:

  6  a subagent run on disk and not in the archive is a gap
     pre-change behaviour: all_accounted_for. It was a side list called
     ``subagents_on_disk_not_archived`` that no verdict ever read.
  7  a roster stem the archive lacks is a gap
     pre-change behaviour: the roster did not exist, so nothing was compared.
  8  an accepted subagent gap passes and is still listed
     pre-change behaviour: there was no disposition for a subagent at all.
  9  a MISSING roster is cannot_evaluate, never all_accounted_for
     pre-change behaviour: all_accounted_for, which is the single most
     dangerous way this checker could be wrong - delete one file and 19,000
     subagent runs stop being checked while the report stays green.
 10  a gap in each population is reported on its OWN line and neither masks the
     other. A merged total would let a clean conversation set hide a missing
     subagent run, which is precisely what the owner asked to be able to see.
 11  an exclusion never changes the verdict, and an empty roster is a reading
     of zero rather than a refusal. The second half is the asymmetry this
     project uses everywhere: a file that was read and held nothing is not the
     same as a file that could not be read.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from typing import List, Sequence

from census_exclusions import render_exclusions
from subagent_roster import ROSTER_HEADER, read_roster, set_digest, write_roster
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


def _write_roster(path: str, stems: Sequence[str]) -> None:
    """Write a throwaway roster file.

    Inputs:
      path: file to create.
      stems: subagent stems it should hold.
    Outputs:
      None.
    """
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(list(ROSTER_HEADER) + sorted(stems)) + "\n")


def _census(conversations: dict, subagents: dict,
            exclusions: Sequence[dict] = ()) -> dict:
    """Compose a throwaway census document.

    Inputs:
      conversations: the conversations map.
      subagents: the subagents provenance map.
      exclusions: exclusion records.
    Outputs:
      dict: a census in the shape :func:`evaluate` reads.
    """
    return {"sources": [{"name": "fake nas tarball",
                         "conversation_stems_missing_from_live": []}],
            "conversations": conversations, "subagents": subagents,
            "exclusions": list(exclusions)}


def self_test() -> int:
    """Prove this checker can fail before anyone trusts it passing.

    Eleven controls over two populations. The positive control alone is
    worthless: a function that returned ``all_accounted_for`` unconditionally
    would pass it. The negatives are what make a green run mean something.

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
        ros = os.path.join(tmp, "roster.txt")
        live = ["proj/aaaa.jsonl", "proj/bbbb.jsonl",
                "proj/aaaa/subagents/agent-1111.jsonl"]
        _write_archive(arc, live)
        _write_corpus(root, live)
        _write_roster(ros, ["agent-1111"])
        with open(cen, "w", encoding="utf-8") as handle:
            json.dump(_census({}, {}), handle)

        print("positive control (complete set, both populations):")
        rep0 = evaluate(arc, root, cen, ros)
        check("complete set is all_accounted_for", rep0["verdict"],
              "all_accounted_for")
        check("subagents ever counted", str(rep0["total_subagents_ever"]), "1")

        print("negative control 1 (a conversation on disk is not in the archive):")
        short = os.path.join(tmp, "archive_short.db")
        _write_archive(short, live[:1] + live[2:])
        rep = evaluate(short, root, cen, ros)
        check("missing conversation is a gap", rep["verdict"], "gap")
        check("the gap names the right stem",
              str([g["stem"] for g in rep["open_gaps"]]), "['bbbb']")
        check("the subagent line stays clean",
              str(len(rep["subagent_open_gaps"])), "0")

        print("negative control 2 (the census names a conversation the archive lacks):")
        cen2 = os.path.join(tmp, "census2.json")
        with open(cen2, "w", encoding="utf-8") as handle:
            json.dump(_census({"cccc": {"sources": ["fake nas tarball"],
                                        "disposition": DISPOSITION_OPEN}}, {}),
                      handle)
        rep2 = evaluate(arc, root, cen2, ros)
        check("census-only conversation is a gap", rep2["verdict"], "gap")
        check("it is counted in the ever total",
              str(rep2["total_conversations_ever"]), "3")

        print("negative control 3 (an accepted gap does not fail, and is still listed):")
        cen3 = os.path.join(tmp, "census3.json")
        with open(cen3, "w", encoding="utf-8") as handle:
            json.dump(_census({"cccc": {"sources": ["fake nas tarball"],
                                        "disposition": DISPOSITION_ACCEPTED,
                                        "reason": "owner accepted, test"}}, {}),
                      handle)
        rep3 = evaluate(arc, root, cen3, ros)
        check("accepted gap passes", rep3["verdict"], "all_accounted_for")
        check("accepted gap is still listed",
              str(len(rep3["accepted_gaps"])), "1")

        print("negative control 4 (nothing readable is NOT a pass):")
        check("missing archive is cannot_evaluate",
              evaluate(os.path.join(tmp, "nope.db"), root, cen, ros)["verdict"],
              "cannot_evaluate")
        check("missing census is cannot_evaluate",
              evaluate(arc, root, os.path.join(tmp, "nope.json"), ros)["verdict"],
              "cannot_evaluate")
        bad = os.path.join(tmp, "bad.json")
        with open(bad, "w", encoding="utf-8") as handle:
            handle.write("{not json")
        check("unparseable census is cannot_evaluate",
              evaluate(arc, root, bad, ros)["verdict"], "cannot_evaluate")
        check("unreadable corpus root is cannot_evaluate",
              evaluate(arc, os.path.join(tmp, "nope"), cen, ros)["verdict"],
              "cannot_evaluate")

        print("negative control 5 (the exit code can never disagree with the "
              "printed verdict):")
        for verdict, want in (("all_accounted_for", EXIT_OK),
                              ("gap", EXIT_GAP),
                              ("cannot_evaluate", EXIT_CANNOT_EVALUATE),
                              ("something_nobody_wrote", EXIT_CANNOT_EVALUATE)):
            check(f"exit code for {verdict}",
                  str(exit_code_for(verdict)), str(want))
        check("a conversation gap exits non-zero",
              str(exit_code_for(evaluate(short, root, cen, ros)["verdict"])),
              str(EXIT_GAP))

        print("negative control 6 (a SUBAGENT run on disk is not in the archive):")
        sub_disk = live + ["proj/bbbb/subagents/agent-2222.jsonl"]
        root6 = os.path.join(tmp, "corpus6")
        _write_corpus(root6, sub_disk)
        rep6 = evaluate(arc, root6, cen, ros)
        check("missing subagent run is a gap", rep6["verdict"], "gap")
        check("it lands on the subagent line",
              str([g["stem"] for g in rep6["subagent_open_gaps"]]),
              "['agent-2222']")
        check("it does NOT land on the conversation line",
              str(len(rep6["open_gaps"])), "0")
        check("a subagent gap exits non-zero",
              str(exit_code_for(rep6["verdict"])), str(EXIT_GAP))

        print("negative control 7 (the roster names a subagent the archive lacks):")
        ros7 = os.path.join(tmp, "roster7.txt")
        _write_roster(ros7, ["agent-1111", "agent-9999"])
        rep7 = evaluate(arc, root, cen, ros7)
        check("roster-only subagent is a gap", rep7["verdict"], "gap")
        check("the gap names the right stem",
              str([g["stem"] for g in rep7["subagent_open_gaps"]]),
              "['agent-9999']")
        check("it is counted in the ever total",
              str(rep7["total_subagents_ever"]), "2")

        print("negative control 8 (an accepted SUBAGENT gap does not fail, and "
              "is still listed):")
        cen8 = os.path.join(tmp, "census8.json")
        with open(cen8, "w", encoding="utf-8") as handle:
            json.dump(_census({}, {"agent-9999": {
                "sources": ["fake nas tarball"],
                "disposition": DISPOSITION_ACCEPTED,
                "reason": "owner accepted, test"}}), handle)
        rep8 = evaluate(arc, root, cen8, ros7)
        check("accepted subagent gap passes", rep8["verdict"],
              "all_accounted_for")
        check("accepted subagent gap is still listed",
              str(len(rep8["subagent_accepted_gaps"])), "1")

        print("negative control 9 (a MISSING roster is never a pass):")
        check("missing roster is cannot_evaluate",
              evaluate(arc, root, cen, os.path.join(tmp, "nope.txt"))["verdict"],
              "cannot_evaluate")
        check("an unreadable roster exits 2",
              str(exit_code_for(evaluate(
                  arc, root, cen, os.path.join(tmp, "nope.txt"))["verdict"])),
              str(EXIT_CANNOT_EVALUATE))

        print("negative control 10 (a gap in each population, neither masked):")
        rep10 = evaluate(short, root6, cen, ros7)
        check("both gapped is a gap", rep10["verdict"], "gap")
        check("conversation gaps still named",
              str([g["stem"] for g in rep10["open_gaps"]]), "['bbbb']")
        check("subagent gaps still named",
              str(sorted(g["stem"] for g in rep10["subagent_open_gaps"])),
              "['agent-2222', 'agent-9999']")

        print("negative control 11 (exclusions inform, an empty roster measures):")
        cen11 = os.path.join(tmp, "census11.json")
        with open(cen11, "w", encoding="utf-8") as handle:
            json.dump(_census({}, {}, [{"id": "x", "name": "some other tool",
                                        "in_scope": False, "conversations": 195,
                                        "counted_at": "2026-09-17T00:00:00Z",
                                        "reachable": True, "location": "/x",
                                        "owner_decision": "not in scope now"}]),
                      handle)
        rep11 = evaluate(arc, root, cen11, ros)
        check("an exclusion does not fail the run", rep11["verdict"],
              "all_accounted_for")
        check("the exclusion is carried into the report",
              str(len(rep11["exclusions"])), "1")
        check("and it renders",
              str(any("195" in line for line in
                      render_exclusions(rep11["exclusions"]))), "True")
        empty = os.path.join(tmp, "roster_empty.txt")
        _write_roster(empty, [])
        rep11b = evaluate(arc, root, cen, empty)
        check("an EMPTY roster is read, not refused", rep11b["verdict"],
              "all_accounted_for")
        check("and it is a reading of zero",
              str(rep11b["roster_subagents"]), "0")

        print("roster mechanics (identity store must not lose or reorder):")
        check("set digest ignores order and duplicates",
              str(set_digest(["b", "a"]) == set_digest(["a", "b", "a"])), "True")
        check("set digest separates different sets",
              str(set_digest(["a"]) == set_digest(["a", "b"])), "False")
        grow = os.path.join(tmp, "roster_grow.txt")
        write_roster(grow, ["agent-a", "agent-b"])
        stats = write_roster(grow, ["agent-b", "agent-c"])
        after, _complete = read_roster(grow)
        check("a refresh that sees less does NOT shrink the roster",
              str(sorted(after)), "['agent-a', 'agent-b', 'agent-c']")
        check("and it says what it would have dropped",
              str(stats["would_have_dropped"]), "1")

    if failures:
        print(f"\nSELF-TEST FAILED: {len(failures)} control(s) misbehaved: "
              f"{failures}")
        return 1
    print("\nSELF-TEST PASSED: every negative control produced a non-zero "
          "verdict, so a green run means something.")
    return 0


if __name__ == "__main__":
    raise SystemExit(self_test())
