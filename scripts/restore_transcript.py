#!/usr/bin/env python3
"""Write a conversation's transcript back to disk from the archive.

DRY RUN IS THE DEFAULT AND IS THE ONLY MODE THAT NEEDS NO ARGUMENT.
``--apply`` exists so a human can act on a report he has read.

WHAT THIS IS FOR. A conversation whose transcript is gone cannot be
resumed: ``claude --resume <uuid>`` looks for
``~/.claude/projects/<project-dir>/<uuid>.jsonl`` and exits when it is
not there. The archive holds the original bytes of 23,659 transcripts and
reconstructs them byte-exactly, so the file can be put back and the
conversation picked up where it stopped.

THE THREE THINGS THIS REFUSES TO DO, because each one destroys a
conversation rather than restoring one:

* It will not write over an existing transcript. ``--overwrite`` is a
  separate, explicit opt-in, and it takes a ``.bak`` first.
* It will not write over a file that is LONGER than what the archive
  holds, EVEN UNDER ``--overwrite``. That shape means the archive is
  behind the live file, and writing would truncate a live conversation.
* It will not write bytes whose sha256 disagrees with the archive's own
  ``content_sha256``. A reconstruction that is not what was ingested is
  refused, not repaired.

WHERE THE FILE GOES IS MEASURED, NOT GUESSED. The destination is the
``source_path`` the archive recorded when it read the file, so the
cwd-spelling trap (``~/Development`` is a symlink into iCloud, and
Claude Code slugs the LITERAL cwd) cannot be got wrong here: whichever
spelling claude used is the directory the file is restored to. The slug
rule is run independently and REPORTED as a cross-check that never
decides.

NOT EVERY TRANSCRIPT IS RESUMABLE. 21,385 of the 23,659 rows in the live
archive are ``kind='subagent'`` - ``agent-*.jsonl`` under
``<uuid>/subagents/`` - which claude reads as part of a parent
conversation and never opens by uuid. Restoring one is useful; resuming
it is not a thing, and the report says so per row rather than letting a
reader assume.

Usage::

    # what would happen, and nothing else
    venv/bin/python3 scripts/restore_transcript.py --uuid 10e4e7bf-...

    # several, from a file of uuids, still a dry run
    venv/bin/python3 scripts/restore_transcript.py --uuid-file ids.txt

    # actually write
    venv/bin/python3 scripts/restore_transcript.py --uuid 10e4e7bf-... --apply

    # restore into a staging tree instead of the live corpus
    venv/bin/python3 scripts/restore_transcript.py --uuid X \\
        --corpus-root /tmp/staging --create-dirs --apply
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.core.transcript_restore_outcomes import (  # noqa: E402
    DRY_RUN,
    WRITTEN,
)
from src.core.transcript_restore_plan import (  # noqa: E402
    RestorePlan,
    apply_restore,
    plan_restore,
)
from src.core.transcript_restore_target import (  # noqa: E402
    CORROBORATION_AGREES,
    default_corpus_root,
)

#: Exit code for a run that could not be performed at all. NOT a pass.
EXIT_CANNOT_RUN: int = 2

#: Exit code for a run that completed with at least one refusal.
EXIT_REFUSED: int = 1


def _default_state_dir() -> Path:
    """Where this install keeps cloude.db and cloude-archive.db.

    Description: asks :class:`src.config.Settings` rather than hardcoding
      the Application Support path, so an install with a relocated state
      directory is found. Importing Settings has side effects, so it is
      done at call time and only when no ``--state-dir`` was given.
    Inputs: none.
    Output: Path.
    Example: _default_state_dir()
      # Path('/Users/x/Library/Application Support/CloudeCode')
    """
    from src.config import settings  # noqa: PLC0415

    return Path(settings.get_state_dir())


def _read_uuids(args: argparse.Namespace) -> List[str]:
    """Collect the uuids this run is about, from either argument.

    Description: blank lines and ``#`` comments in a uuid file are
      skipped, so a human can annotate a list he is working through.
    Inputs: args (argparse.Namespace) with ``uuid`` and ``uuid_file``.
    Output: list[str] - in the order given, duplicates removed.
    Example: _read_uuids(ns) -> ['10e4e7bf-...']
    """
    out: List[str] = []
    for value in args.uuid or []:
        if value not in out:
            out.append(value)
    if args.uuid_file:
        for raw in Path(args.uuid_file).read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line not in out:
                out.append(line)
    return out


def _plan_dict(plan: RestorePlan) -> dict:
    """Flatten a plan into a JSON-serialisable report row.

    Description: every stage's named outcome is carried, including the
      ones that were never reached, which show as null rather than being
      omitted - a reader must be able to see WHERE a run stopped.
    Inputs: plan (RestorePlan).
    Output: dict.
    Example: _plan_dict(plan)['blocked_at'] -> 'target_exists'
    """
    row = plan.row
    return {
        "uuid": plan.conversation_uuid,
        "resolve": plan.resolve.outcome,
        "reconstruct": plan.reconstruct.outcome if plan.reconstruct else None,
        "target": plan.target.outcome if plan.target else None,
        "write": plan.write.outcome if plan.write else None,
        "blocked_at": plan.blocked_at,
        "ready": plan.ready,
        "resumable": plan.resumable,
        "archive_id": row.archive_id if row else None,
        "kind": row.kind if row else None,
        "source_path": row.source_path if row else None,
        "content_sha256": row.content_sha256 if row else None,
        "byte_length": row.raw_byte_length if row else None,
        "ingested_at": row.ingested_at if row else None,
        "path": str(plan.target.path) if plan.target and plan.target.path else None,
        "corroboration": plan.corroboration.verdict if plan.corroboration else None,
        "verified_sha256": plan.write.verified_sha256 if plan.write else None,
        "backup_path": (
            str(plan.write.backup_path)
            if plan.write and plan.write.backup_path
            else None
        ),
        "detail": _detail_of(plan),
    }


def _detail_of(plan: RestorePlan) -> str:
    """The sentence explaining the first stage that had something to say.

    Inputs: plan (RestorePlan).
    Output: str - possibly empty.
    Example: _detail_of(plan) -> 'no transcript_archives row names abc'
    """
    for stage in (plan.write, plan.target, plan.reconstruct, plan.resolve):
        if stage is not None and getattr(stage, "detail", ""):
            return stage.detail
    return ""


def _print_plan(plan: RestorePlan, applied: bool) -> None:
    """Print one plan as the human-readable block.

    Inputs: plan (RestorePlan), applied (bool) - whether --apply was on.
    Output: None.
    Example: _print_plan(plan, False)
    """
    row = plan.row
    verb = "WROTE" if (plan.write and plan.write.outcome == WRITTEN) else (
        "WOULD WRITE" if plan.ready and not applied else "REFUSED"
    )
    print(f"\n{plan.conversation_uuid}")
    print(f"  verdict          {verb}")
    print(f"  stage            {plan.resolve.outcome}")
    if row is None and plan.resolve.candidates:
        # An ambiguous uuid is only actionable if the operator is shown
        # what to choose between.
        print("  candidates       (pass one to --source-path)")
        for candidate in plan.resolve.candidates:
            print(f"    {candidate}")
    if row is not None:
        print(f"  archive_id       {row.archive_id}  ({row.kind}, {row.growth_kind})")
        print(f"  ingested_at      {row.ingested_at}")
        print(f"  bytes            {row.raw_byte_length}")
        print(f"  content_sha256   {row.content_sha256}")
        print(f"  resumable        {plan.resumable}"
              f"{'' if plan.resumable else '  (subagent transcript; --resume cannot open it)'}")
    if plan.reconstruct is not None:
        print(f"  reconstruct      {plan.reconstruct.outcome}"
              f"  sha256={plan.reconstruct.actual_sha256[:16]}...")
    if plan.target is not None:
        print(f"  target           {plan.target.outcome}")
        print(f"  path             {plan.target.path}")
    if plan.corroboration is not None:
        mark = "ok" if plan.corroboration.verdict == CORROBORATION_AGREES else "note"
        print(f"  slug cross-check {plan.corroboration.verdict} ({mark})")
        if plan.corroboration.verdict != CORROBORATION_AGREES:
            print(f"    recorded dir   {plan.corroboration.recorded_dir}")
            print(f"    cwd            {plan.corroboration.cwd}")
            print(f"    slug rule says {plan.corroboration.derived_dirs}")
    if plan.write is not None:
        print(f"  write            {plan.write.outcome}"
              f"  {plan.write.bytes_written} bytes"
              f"  verified={plan.write.verified_sha256[:16]}...")
        if plan.write.backup_path:
            print(f"  backup           {plan.write.backup_path}")
    detail = _detail_of(plan)
    if detail:
        print(f"  why              {detail}")


def main(argv: Optional[List[str]] = None) -> int:
    """Parse arguments, plan every uuid, optionally write, report.

    Inputs: argv (list[str] | None).
    Output: int exit code. 0 every uuid was ready (and written, under
      --apply); 1 at least one refusal; 2 the run could not be performed,
      which is NOT a pass.
    Example: main(['--uuid', 'abc']) -> 1
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--uuid", action="append", help="conversation uuid (repeatable)")
    parser.add_argument("--uuid-file", help="file of uuids, one per line")
    parser.add_argument("--state-dir", help="override the install's state directory")
    parser.add_argument(
        "--corpus-root",
        help="where transcripts live; defaults to ~/.claude/projects. Point it "
             "at a staging directory to rehearse without touching the live corpus",
    )
    parser.add_argument(
        "--source-path", help="disambiguate a uuid that names two transcripts"
    )
    parser.add_argument(
        "--apply", action="store_true", help="actually write (default is a dry run)"
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="replace an existing transcript, taking a .bak first. Still "
             "refuses when the file on disk is longer than the archive.",
    )
    parser.add_argument(
        "--create-dirs", action="store_true", help="create a missing project directory"
    )
    parser.add_argument("--json", action="store_true", help="machine-readable report")
    args = parser.parse_args(argv)

    uuids = _read_uuids(args)
    if not uuids:
        print("give at least one --uuid or a --uuid-file", file=sys.stderr)
        return EXIT_CANNOT_RUN

    try:
        state_dir = Path(args.state_dir) if args.state_dir else _default_state_dir()
    except (OSError, ValueError, SystemExit) as exc:
        # Settings hard-exits when .env is absent, which is the ordinary
        # shape of a repo checkout that is not itself the running install.
        # Naming the escape hatch is the difference between a dead end and
        # a one-flag fix.
        print(
            f"could not determine the state directory ({exc}). Pass --state-dir, "
            "e.g. --state-dir "
            "'~/Library/Application Support/CloudeCode'",
            file=sys.stderr,
        )
        return EXIT_CANNOT_RUN

    corpus_root = Path(args.corpus_root) if args.corpus_root else default_corpus_root()
    if args.source_path and len(uuids) != 1:
        print("--source-path applies to exactly one --uuid", file=sys.stderr)
        return EXIT_CANNOT_RUN

    if not args.json:
        print(f"state dir    {state_dir}")
        print(f"corpus root  {corpus_root}")
        print(f"mode         {'APPLY' if args.apply else 'DRY RUN (nothing is written)'}")

    rows: List[dict] = []
    refused = 0
    for conversation_uuid in uuids:
        plan = plan_restore(
            state_dir,
            conversation_uuid,
            corpus_root=corpus_root,
            source_path=args.source_path,
            overwrite=args.overwrite,
            create_dirs=args.create_dirs,
        )
        if args.apply and plan.ready:
            plan = apply_restore(
                plan, overwrite=args.overwrite, create_dirs=args.create_dirs
            )
        ok = plan.ready and (
            not args.apply or (plan.write is not None and plan.write.outcome == WRITTEN)
        )
        if not ok:
            refused += 1
        rows.append(_plan_dict(plan))
        if not args.json:
            _print_plan(plan, args.apply)

    if args.json:
        json.dump({"mode": "apply" if args.apply else DRY_RUN, "rows": rows},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"\n{len(uuids) - refused} of {len(uuids)} "
              f"{'written' if args.apply else 'ready'}, {refused} refused")

    return EXIT_REFUSED if refused else 0


if __name__ == "__main__":
    raise SystemExit(main())
