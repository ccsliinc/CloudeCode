"""One conversation uuid in, one decided restore plan out.

THIS IS THE SEAM, AND IT DECIDES NOTHING ITSELF. Resolution lives in
:mod:`src.core.transcript_restore_resolve`, the destination in
:mod:`src.core.transcript_restore_target`, the write in
:mod:`src.core.transcript_restore_write`. This module runs them in the
one order that is safe and carries the result.

THE ORDER IS THE POINT. Reconstruct and SELF-VERIFY before looking at the
destination, so bytes the archive does not vouch for can never reach a
path decision; then decide the destination, so a human sees where the
file would land before anything is attempted; then, and only on an
explicit ``apply``, write.

DRY RUN IS THE DEFAULT AT EVERY LAYER, not only in the script.
:func:`plan_restore` never writes. :func:`apply_restore` is a separate
function a caller has to reach for by name. A library whose safe mode is
a keyword argument gets called wrongly eventually.

A PLAN THAT REFUSES IS STILL A COMPLETE PLAN. Every refusal carries the
uuid, the outcome name, and the sentence explaining it, so a batch run
over hundreds of uuids produces a report rather than a stack trace.
"""

from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import structlog

from src.core.db import DatastoreError
from src.core.transcript_restore_outcomes import (
    DATABASE_UNREADABLE,
    DRY_RUN,
    RECONSTRUCTED,
    RESOLVED,
    TARGET_READY,
    WRITE_FAILED,
    WRITTEN,
)
from src.core.transcript_restore_resolve import (
    ArchiveRowRef,
    ReconstructResult,
    ResolveResult,
    reconstruct_row,
    resolve_uuid,
    restore_connection,
)
from src.core.transcript_restore_target import (
    Corroboration,
    TargetDecision,
    corroborate_directory,
    resolve_target,
)
from src.core.transcript_restore_write import WriteResult, write_transcript

logger = structlog.get_logger()


@dataclass(frozen=True)
class RestorePlan:
    """Everything decided about restoring one conversation.

    Description: the four stage results, each carrying its own named
      outcome, plus the derived questions a report wants to ask without
      re-deriving them. ``blocked_at`` names the FIRST stage that refused,
      which is what a human reads; every later stage is simply absent
      because it was never reached.
    Inputs: constructed by :func:`plan_restore`.
    Output: n/a (data holder).
    """

    conversation_uuid: str
    resolve: ResolveResult
    reconstruct: Optional[ReconstructResult] = None
    target: Optional[TargetDecision] = None
    corroboration: Optional[Corroboration] = None
    write: Optional[WriteResult] = None

    @property
    def row(self) -> Optional[ArchiveRowRef]:
        """The archive row this plan is about, when one was resolved.

        Inputs: none.
        Output: ArchiveRowRef | None.
        Example: plan.row.archive_id -> 22422
        """
        return self.resolve.row

    @property
    def ready(self) -> bool:
        """Whether every stage before the write said yes.

        Description: the single question the script branches on. Derived
          from the three stage outcomes rather than set by whoever built
          the plan, so it cannot disagree with them.
        Inputs: none.
        Output: bool.
        Example: plan.ready -> True
        """
        return (
            self.resolve.outcome == RESOLVED
            and self.reconstruct is not None
            and self.reconstruct.outcome == RECONSTRUCTED
            and self.target is not None
            and self.target.outcome == TARGET_READY
        )

    @property
    def blocked_at(self) -> Optional[str]:
        """The outcome name of the first stage that refused, or None.

        Inputs: none.
        Output: str | None.
        Example: plan.blocked_at -> 'target_exists'
        """
        if self.resolve.outcome != RESOLVED:
            return self.resolve.outcome
        if self.reconstruct is None or self.reconstruct.outcome != RECONSTRUCTED:
            return None if self.reconstruct is None else self.reconstruct.outcome
        if self.target is None or self.target.outcome != TARGET_READY:
            return None if self.target is None else self.target.outcome
        if self.write is not None and self.write.outcome not in (WRITTEN, DRY_RUN):
            return self.write.outcome
        return None

    @property
    def resumable(self) -> bool:
        """Whether ``claude --resume`` could address this transcript.

        Description: false for a subagent transcript, which is a real
          transcript worth restoring that ``--resume`` cannot open. Said
          out loud rather than quietly implied, because 21,385 of the
          23,659 rows in the live archive are subagent rows.
        Inputs: none.
        Output: bool.
        Example: plan.resumable -> True
        """
        return self.row is not None and self.row.resumable


def plan_restore(
    state_dir: Path,
    conversation_uuid: str,
    *,
    corpus_root: Optional[Path] = None,
    source_path: Optional[str] = None,
    overwrite: bool = False,
    create_dirs: bool = False,
    home: Optional[Path] = None,
) -> RestorePlan:
    """Decide everything about one restore, WITHOUT writing anything.

    Description: opens the archive read-side, resolves the uuid,
      reconstructs and self-verifies the bytes, then decides the
      destination. See the module docstring for why that order is the
      safe one.
    Inputs: state_dir (Path) - the install's state directory.
      conversation_uuid (str) - the transcript's file stem. corpus_root
      (Path | None) - override for tests. source_path (str | None) -
      disambiguate an AMBIGUOUS_UUID. overwrite (bool), create_dirs
      (bool) - relax the corresponding target refusals. home
      (Path | None) - test override for the corroboration's alias scan.
    Output: RestorePlan.
    Example: plan_restore(state_dir, 'abc').blocked_at -> 'no_archive_row'
    """
    try:
        conn = restore_connection(state_dir)
    except DatastoreError as exc:
        return RestorePlan(
            conversation_uuid,
            ResolveResult(DATABASE_UNREADABLE, detail=str(exc)),
        )

    with closing(conn):
        resolved = resolve_uuid(conn, conversation_uuid, source_path=source_path)
        if resolved.outcome != RESOLVED or resolved.row is None:
            return RestorePlan(conversation_uuid, resolved)
        rebuilt = reconstruct_row(conn, resolved.row)

    if rebuilt.outcome != RECONSTRUCTED or rebuilt.data is None:
        return RestorePlan(conversation_uuid, resolved, reconstruct=rebuilt)

    corroboration = corroborate_directory(
        rebuilt.data, resolved.row.source_path, home=home
    )
    target = resolve_target(
        resolved.row.source_path,
        len(rebuilt.data),
        corpus_root=corpus_root,
        overwrite=overwrite,
        create_dirs=create_dirs,
    )
    return RestorePlan(
        conversation_uuid,
        resolved,
        reconstruct=rebuilt,
        target=target,
        corroboration=corroboration,
    )


def apply_restore(
    plan: RestorePlan, *, overwrite: bool = False, create_dirs: bool = False
) -> RestorePlan:
    """Carry out a plan that is ready, and return it with the write result.

    Description: refuses a plan that is not :attr:`RestorePlan.ready`
      rather than re-deciding anything - a caller that wants a different
      answer must build a different plan, so the decision a human was
      shown is the decision that gets executed.
    Inputs: plan (RestorePlan) - from :func:`plan_restore`. overwrite
      (bool), create_dirs (bool) - passed through to the writer; they
      must match what the plan was built with or the plan's own target
      decision would not have cleared.
    Output: RestorePlan - the same plan with ``write`` populated.
    Example: apply_restore(plan).write.outcome -> 'written'
    """
    if not plan.ready or plan.target is None or plan.target.path is None:
        return RestorePlan(
            plan.conversation_uuid,
            plan.resolve,
            reconstruct=plan.reconstruct,
            target=plan.target,
            corroboration=plan.corroboration,
            write=WriteResult(
                WRITE_FAILED,
                path=plan.target.path if plan.target else None,
                detail=(
                    "plan is not ready; refusing to write. blocked at "
                    f"{plan.blocked_at!r}"
                ),
            ),
        )

    assert plan.reconstruct is not None and plan.reconstruct.data is not None
    result = write_transcript(
        plan.target.path,
        plan.reconstruct.data,
        plan.reconstruct.expected_sha256,
        allow_overwrite=overwrite,
        create_dirs=create_dirs,
    )
    return RestorePlan(
        plan.conversation_uuid,
        plan.resolve,
        reconstruct=plan.reconstruct,
        target=plan.target,
        corroboration=plan.corroboration,
        write=result,
    )
