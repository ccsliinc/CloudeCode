#!/usr/bin/env python3
"""Answer one question: is EVERY conversation the owner has ever had in the archive?

WHY THIS EXISTS. ``verify_archive_integrity.py`` beside this file answers a
DIFFERENT question: for the rows the archive HAS, are the bytes sound? It walks
supersession chains and compares reconstructions to disk. It cannot see a
conversation the archive never ingested, because it iterates the archive's own
rows. A conversation that exists only in a tarball on the NAS, or only in a git
commit from December 2025, is invisible to it and always will be. This script
iterates the OTHER direction: from a recorded census of every conversation ever
observed ANYWHERE, into the live archive, and reports what is not there.

WHAT A CONVERSATION IS, PRECISELY. One real Claude Code session transcript.
Identity is the FILE STEM of its ``.jsonl`` (``<uuid>.jsonl`` -> ``<uuid>``),
never the path and never the ``sessionId`` inside it. Path is wrong because the
same conversation appears under both the short ``-Users-jsugamele-Development-*``
slug and the long iCloud slug of the same directory; a pass that compared paths
once reported near-total loss. ``sessionId`` is wrong because an
``agent-<id>.jsonl`` subagent run records its PARENT's sessionId, so keying on it
collapses thousands of distinct files onto one id.

SUBAGENT RUNS ARE COUNTED SEPARATELY AND ARE NOT CONVERSATIONS. An
``agent-*.jsonl`` is a sub-task this app spawned inside a conversation, not
something the owner sat down and had. Both are counted; the verdict leads with
conversations, and the subagent number is reported beside it so it can never be
quietly folded in to make a total look better.

THE THREE SOURCES, AND WHY THE THIRD IS A FILE RATHER THAN A SCAN.

  live archive   ``transcript_archives.source_path`` in cloude-archive.db.
                 This is the thing being audited.
  disk corpus    every ``*.jsonl`` under the corpus root. Anything here and
                 not in the archive is an ingest that has not happened yet.
  census         ``conversation_census.json`` beside this file: every
                 conversation stem ever OBSERVED in any offline source (NAS
                 databases, NAS tarball manifests, local database backups),
                 recorded with which sources held it. It is a file and not a
                 scan because the NAS is not always reachable and a check that
                 answers nothing when a server is down is a check nobody runs.

EXIT CODES. 0 every conversation accounted for. 1 a gap: at least one
conversation is known to exist and is not in the live archive. 2 could not
evaluate. NOT HAVING LOOKED IS NEVER A PASS, which is the whole reason 2 is
distinct from 0: an unreadable database, a missing census and an unreadable
corpus root all exit 2, never 0.

AN ACCEPTED GAP IS STILL PRINTED, EVERY RUN. A census entry may carry
``disposition: "accepted"`` with a reason, for a conversation the owner has
decided to leave outside the archive. Accepted entries do not fail the run, and
they are listed on every single run regardless, because a gap that stops being
mentioned is a gap that stops being known. Anything else is ``open`` and fails.

THE SELF-TEST IS THE ONLY REASON TO TRUST A GREEN RUN. ``--self-test`` builds a
throwaway archive, corpus and census and drives this exact code path through a
positive control and four negative controls, including the one that matters: a
checker that always answered "all accounted for" would pass the positive control
perfectly. Watch the negatives go red before you believe a green.

READ ONLY. The archive is opened ``mode=ro`` plus ``PRAGMA query_only=ON``, so
this is safe against the live file while the corpus ingester writes to it. Note
that makes any single run a SNAPSHOT of a moving file: a conversation created in
the last few minutes can legitimately read as a disk-not-archive gap until the
ingester's next pass, and the report labels that case rather than hiding it.

Usage:
  python3 verify_all_conversations.py [--archive PATH] [--corpus-root PATH]
                                      [--census PATH] [--json OUT.json]
                                      [--quiet] [--self-test]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Dict, List, Optional, Sequence, Set, Tuple

from conversation_sources import (SUBAGENT_PREFIX, CannotEvaluate, is_subagent,
                                  read_archive, read_census, read_corpus,
                                  split_stems, stem_of)

#: Live transcript archive maintained by the running app.
DEFAULT_ARCHIVE = os.path.expanduser(
    "~/Library/Application Support/CloudeCode/cloude-archive.db")

#: Root the app's ``source_path`` values are relative to. On this machine it is
#: a symlink into iCloud, so every walk uses ``followlinks=True``.
DEFAULT_CORPUS_ROOT = os.path.expanduser("~/.claude/projects")

#: The recorded census of offline sources, committed beside this script.
DEFAULT_CENSUS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "conversation_census.json")

#: Census dispositions. ``open`` fails the run; ``accepted`` does not, and is
#: printed every run anyway.
DISPOSITION_OPEN = "open"
DISPOSITION_ACCEPTED = "accepted"

EXIT_OK, EXIT_GAP, EXIT_CANNOT_EVALUATE = 0, 1, 2


def evaluate(archive_path: str, corpus_root: str, census_path: str) -> dict:
    """Run the whole check and return a report.

    Inputs:
      archive_path: live cloude-archive.db.
      corpus_root: on-disk corpus root.
      census_path: recorded census json.
    Outputs:
      dict: the report, always carrying ``verdict`` in
        {all_accounted_for, gap, cannot_evaluate}.
    """
    started = time.time()
    report: dict = {
        "verdict": None,
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "archive_path": archive_path,
        "corpus_root": corpus_root,
        "census_path": census_path,
        "sources": [],
        "cannot_evaluate": [],
    }
    try:
        arc_conv, arc_sub, arc_rows = read_archive(archive_path)
    except CannotEvaluate as exc:
        report["verdict"] = "cannot_evaluate"
        report["cannot_evaluate"].append(str(exc))
        return report

    report["archive_rows"] = arc_rows
    report["archive_conversations"] = len(arc_conv)
    report["archive_subagents"] = len(arc_sub)
    report["sources"].append({
        "name": "live archive", "kind": "database", "reachable": True,
        "conversations": len(arc_conv), "subagents": len(arc_sub),
        "conversations_missing": 0, "subagents_missing": 0,
    })

    ever_conv: Set[str] = set(arc_conv)
    ever_sub: Set[str] = set(arc_sub)
    open_gaps: List[dict] = []
    accepted_gaps: List[dict] = []

    try:
        disk_conv, disk_sub, disk_where = read_corpus(corpus_root)
    except CannotEvaluate as exc:
        report["cannot_evaluate"].append(str(exc))
        disk_conv, disk_sub, disk_where = set(), set(), {}
        report["sources"].append({
            "name": "disk corpus", "kind": "filesystem", "reachable": False,
            "conversations": None, "subagents": None,
            "conversations_missing": None, "subagents_missing": None,
        })
    else:
        ever_conv |= disk_conv
        ever_sub |= disk_sub
        missing_disk = sorted(disk_conv - arc_conv)
        report["sources"].append({
            "name": "disk corpus", "kind": "filesystem", "reachable": True,
            "conversations": len(disk_conv), "subagents": len(disk_sub),
            "conversations_missing": len(missing_disk),
            "subagents_missing": len(disk_sub - arc_sub),
        })
        for stem in missing_disk:
            open_gaps.append({
                "stem": stem, "kind": "conversation",
                "sources": ["disk corpus"],
                "where": disk_where.get(stem),
                "note": "on disk and not yet ingested; if this file is minutes "
                        "old the ingester has simply not run since",
            })
        report["subagents_on_disk_not_archived"] = sorted(disk_sub - arc_sub)

    try:
        census = read_census(census_path)
    except CannotEvaluate as exc:
        report["verdict"] = "cannot_evaluate"
        report["cannot_evaluate"].append(str(exc))
        return report

    for source in census.get("measured_once", []):
        entry = dict(source)
        entry["reachable"] = True
        entry["recorded_reading"] = True
        held = set(source.get("conversations_missing_from_live", []))
        entry["conversations_missing"] = len(held - arc_conv)
        report["sources"].append(entry)
        for stem in held:
            ever_conv.add(stem)

    for source in census["sources"]:
        # The census records the live archive and the disk corpus too, because
        # the builder walks everything it can see. Both were just MEASURED
        # above, and a recorded reading must never be printed beside a fresh one
        # as though they were two independent sources agreeing.
        if source.get("name") in ("live archive", "disk corpus"):
            continue
        entry = dict(source)
        held = set(source.get("conversation_stems_missing_from_live", []))
        entry["conversations_missing"] = len(held - arc_conv)
        report["sources"].append(entry)

    for stem, record in sorted(census["conversations"].items()):
        ever_conv.add(stem)
        if stem in arc_conv:
            continue
        item = {
            "stem": stem, "kind": "conversation",
            "sources": record.get("sources", []),
            "where": record.get("where"),
            "bytes": record.get("bytes"),
            "observed": record.get("observed"),
            "recoverability": record.get("recoverability"),
            "note": record.get("note"),
        }
        if record.get("disposition") == DISPOSITION_ACCEPTED:
            item["reason"] = record.get("reason")
            accepted_gaps.append(item)
        else:
            open_gaps.append(item)

    # Subagent runs are counted, not enumerated (see the census docstring), with
    # one exception: a run KNOWN to be missing from the live archive is recorded
    # by stem so it can be named. Those are reported, never folded into the
    # conversation verdict, because a subagent run is not a conversation.
    missing_sub: List[dict] = []
    for stem, record in sorted(census.get("subagents", {}).items()):
        ever_sub.add(stem)
        if stem not in arc_sub:
            missing_sub.append({"stem": stem, "sources": record.get("sources", []),
                                "where": record.get("where"),
                                "bytes": record.get("bytes")})
    report["subagent_gaps"] = missing_sub

    report["total_conversations_ever"] = len(ever_conv)
    report["total_subagents_ever"] = len(ever_sub)
    report["open_gaps"] = open_gaps
    report["accepted_gaps"] = accepted_gaps
    report["elapsed_seconds"] = round(time.time() - started, 3)
    report["verdict"] = verdict_for(report)
    return report


def verdict_for(report: dict) -> str:
    """Derive the verdict from the report, and from nothing else.

    THE EXIT CODE IS DERIVED FROM THIS AND SO IS THE PRINTED HEADLINE, so the
    three can never disagree. They did once: the verdict read a local variable
    while the exit code read ``report["open_gaps"]``, and a mutation that
    emptied only the report key printed "VERDICT: GAP" while exiting 0. A
    checker that says gap and exits success is worse than no checker.

    Inputs:
      report: a report dict carrying ``cannot_evaluate`` and ``open_gaps``.
    Outputs:
      str: one of all_accounted_for, gap, cannot_evaluate.
    """
    if report.get("cannot_evaluate"):
        return "cannot_evaluate"
    return "gap" if report.get("open_gaps") else "all_accounted_for"


def render(report: dict, quiet: bool = False) -> None:
    """Print a report to stdout in the shape the owner reads.

    Inputs:
      report: the dict from :func:`evaluate`.
      quiet: when True, print only the headline and any gap.
    Outputs:
      None.
    """
    verdict = report["verdict"]
    if verdict == "cannot_evaluate":
        print("VERDICT: COULD NOT EVALUATE")
        for line in report["cannot_evaluate"]:
            print(f"  {line}")
        print("\nnot having looked is not a pass. exit 2.")
        return

    ever = report["total_conversations_ever"]
    have = report["archive_conversations"]
    print(f"conversations ever observed anywhere : {ever}")
    print(f"conversations in the live archive now: {have}")
    print(f"subagent runs ever observed          : {report['total_subagents_ever']}"
          f"  (in archive: {report['archive_subagents']})")
    if not quiet:
        print(f"\narchive rows: {report['archive_rows']}   "
              f"checked at {report['checked_at']}   "
              f"{report['elapsed_seconds']}s")
        print("\nsources checked:")
        for source in report["sources"]:
            reach = "" if source.get("reachable", True) else "  UNREACHABLE"
            if source.get("recorded_reading"):
                reach += f"  (recorded {source.get('measured_at')}, not re-read)"
            miss = source.get("conversations_missing")
            miss_s = "?" if miss is None else str(miss)
            print(f"  {source['name']:<44} "
                  f"conv={str(source.get('conversations')):>6} "
                  f"missing_from_live={miss_s:>4}{reach}")

    accepted = report.get("accepted_gaps", [])
    if accepted:
        print(f"\nACCEPTED, outside the archive on purpose ({len(accepted)}):")
        for item in accepted:
            print(f"  {item['stem']}  {item.get('reason')}")

    sub_gaps = report.get("subagent_gaps", [])
    if sub_gaps:
        print(f"\nsubagent runs known to exist and not in the archive "
              f"({len(sub_gaps)}). These are sub-tasks, NOT conversations, and "
              f"they do not change the verdict:")
        for item in sub_gaps:
            print(f"  {item['stem']}  {item.get('where') or ''}")

    gaps = report.get("open_gaps", [])
    if not gaps:
        print("\nVERDICT: ALL ACCOUNTED FOR")
        return
    print(f"\nVERDICT: GAP. {len(gaps)} conversation(s) known to exist "
          f"and not in the live archive:")
    for item in gaps:
        src = ", ".join(item.get("sources") or []) or "unknown source"
        size = f"  {item['bytes']} bytes" if item.get("bytes") else ""
        print(f"  {item['stem']}  [{src}]{size}")
        if item.get("where"):
            print(f"      at: {item['where']}")
        if item.get("recoverability"):
            print(f"      recoverability: {item['recoverability']}")
        if item.get("note"):
            print(f"      note: {item['note']}")


def exit_code_for(verdict: str) -> int:
    """Map a verdict to this project's exit convention.

    Inputs:
      verdict: all_accounted_for, gap, or cannot_evaluate.
    Outputs:
      int: 0, 1, or 2. An UNRECOGNISED verdict is 2, never 0: a verdict this
        function does not understand is a thing nobody has looked at properly.
    Example:
      >>> exit_code_for("gap")
      1
    """
    return {"all_accounted_for": EXIT_OK,
            "gap": EXIT_GAP,
            "cannot_evaluate": EXIT_CANNOT_EVALUATE}.get(
                verdict, EXIT_CANNOT_EVALUATE)


def main(argv: Optional[Sequence[str]] = None) -> int:
    """CLI entry point.

    Inputs:
      argv: argument vector, defaulting to ``sys.argv[1:]``.
    Outputs:
      int: 0 all accounted for, 1 gap, 2 could not evaluate.
    """
    parser = argparse.ArgumentParser(
        description="is every conversation in the archive?")
    parser.add_argument("--archive", default=DEFAULT_ARCHIVE)
    parser.add_argument("--corpus-root", default=DEFAULT_CORPUS_ROOT)
    parser.add_argument("--census", default=DEFAULT_CENSUS)
    parser.add_argument("--json", help="write the full report here")
    parser.add_argument("--quiet", action="store_true",
                        help="headline and gaps only")
    parser.add_argument("--self-test", action="store_true",
                        help="prove this checker can fail, then exit")
    args = parser.parse_args(argv)

    if args.self_test:
        from verify_all_conversations_selftest import self_test
        return self_test()

    report = evaluate(args.archive, args.corpus_root, args.census)
    render(report, quiet=args.quiet)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
        print(f"\nfull report written to {args.json}")
    return exit_code_for(report["verdict"])


if __name__ == "__main__":
    raise SystemExit(main())
