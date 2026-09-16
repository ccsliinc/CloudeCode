"""Act on one rename-retry decision: witness, decide, and maybe push.

The seam between the pure ladder in :mod:`src.core.claude_rename_retry`,
the durable ledger beside it, and the out-of-band push that
:mod:`src.core.claude_rename` already owns. It exists as its own module
for the reason ``session_agent_infer_apply`` does: the rules stay
testable with no filesystem and no subprocess, and
``claude_title_sync_apply`` gains six lines rather than ninety.

IT RUNS WHERE THE TITLE SYNC ALREADY RUNS, and it is deliberately not a
new background loop. ``sync_claude_title`` is reached from the attention
watcher on a transcript that grew, which is the strictly tighter trigger
the sync itself was given when the hook route was deleted, and it is
guaranteed to fire for exactly the sessions a pending push could still
reach. Everything this seam needs - the row id, both title columns, the
conversation uuid and the transcript verdict - was already read on that
pass, so the steady-state cost of the whole feature is two dictionary
lookups and a string comparison.

NOTHING EXPENSIVE HAPPENS BEFORE THE LADDER HAS SAID YES.
``detect_claude_version`` shells out to ``claude --version`` and
``spawn_oob_rename`` starts a subprocess, so both sit BEHIND
:data:`RETRY_PUSH`. A box with nothing pending spends no process at all,
which is what makes this safe to hang off a per-append trigger.

THE PUSH IS NOT REBUILT. ``decide_push`` still decides, its measured-
absence asymmetry is preserved verbatim - ``unchecked`` still sends -
``oob_rename_argv`` still builds the argv and ``spawn_oob_rename`` still
reaps the child and logs what it actually did. A second spawn here would
have to re-earn the argv-not-a-shell-string rule, the timeout and the
stderr reporting, all of which were written against measured defects. NO
HOOK TOKEN IS MINTED AND NO TMUX SOCKET IS TOUCHED: ``--resume``
addresses the conversation by uuid and never goes near a pane.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Optional

import structlog

from src.core import claude_rename_retry_store as store
from src.core.claude_rename_retry import (
    RETRY_PUSH,
    RetryDecision,
    decide_retry,
    record_agreement,
    record_attempt,
    witness_agreement,
)

logger = structlog.get_logger(__name__)

#: Outcome reported when the push itself was refused by ``decide_push``
#: after the ladder had authorised it - an unsupported claude, a label
#: claude would rewrite, a transcript measured absent. Kept apart from
#: the ladder's own verdicts because it is a statement about the PUSH,
#: not about which side is newer, and it spends no attempt.
RETRY_PUSH_REFUSED: str = "push_refused"

#: Outcome reported when the claude binary could not be resolved. Also
#: spends no attempt: a box that cannot find claude today may find it
#: tomorrow, and charging the budget would exhaust a rename that was
#: never actually tried.
RETRY_NO_BINARY: str = "no_binary"

#: Outcome reported when the whole feature is switched off. Nothing is
#: witnessed, nothing is decided and nothing is written.
RETRY_DISABLED: str = "disabled"

#: The switch. Same shape as ``CLOUDE_CORPUS_INGEST`` and
#: ``CLOUDE_DB_INTEGRITY_CHECK``: an operator can turn it off, and it
#: defaults OFF under ``CLOUDE_TEST_MODE`` so a pytest run can never
#: spawn a real ``claude --resume`` against the developer's own corpus.
#: A test that wants the push path sets it to "1" explicitly.
ENABLE_ENV: str = "CLOUDE_RENAME_RETRY"


def retry_enabled() -> bool:
    """Whether the rename retry may run at all.

    Description: reads :data:`ENABLE_ENV` when it is set and otherwise
      answers False under ``CLOUDE_TEST_MODE`` and True elsewhere. The
      test-mode default is not politeness: the act step spawns
      ``claude -p --resume <uuid>``, which would reach the real corpus
      from inside a unit test, and a suite that starts subprocesses
      against a developer's live data is a suite nobody can trust.
    Inputs: none (reads the environment).
    Output: bool.
    Example: retry_enabled() -> True
    """
    raw = os.environ.get(ENABLE_ENV)
    if raw is not None:
        return raw.strip().lower() not in ("", "0", "false", "no", "off")
    return not os.environ.get("CLOUDE_TEST_MODE")


def _families_agree(agent_family: Optional[str]) -> bool:
    """Whether this row's agent is one ``/rename`` can be sent to.

    Description: mirrors the test ``SessionManager._push_rename_to_claude``
      applies, rather than inventing a second one. A NULL family is
      accepted for the same reason it is there: the column is filled by
      inference and an unfilled one is "not established", while every
      session this app launches with no family recorded is a claude.
      ``decide_push`` refuses on the VERSION anyway, so a non-claude that
      slipped through here cannot produce a send.
    Inputs: agent_family (str | None) - ``sessions.agent_family``.
    Output: bool.
    Example: _families_agree('codex') -> False
    """
    return agent_family in (None, "", "claude")


def run_rename_retry(
    *,
    session_id: str,
    row_id: int,
    title: Optional[str],
    claude_title: Optional[str],
    claude_uuid: Optional[str],
    agent_family: Optional[str],
    sync_action: str,
    now: Optional[float] = None,
    state_dir: Optional[Path] = None,
) -> RetryDecision:
    """Witness the ordering frame, decide, and push when authorised.

    Description: NEVER RAISES ON THE PUSH. This hangs off the watcher's
      tick behind the title sync, and a stuck name is telemetry, so every
      failure of the outward half becomes a logged verdict the caller may
      ignore. Three steps, in this order and for this reason:

      1. WITNESS. If the two columns agree on this pass, record that
         value as the row's ordering frame and clear any retry budget.
         This runs FIRST and unconditionally, because a
         ``TITLE_APPLIED`` pass both writes the agreement and is
         :data:`RETRY_SUPERSEDED` for the decision below - witnessing
         after the ladder would never see it.
      2. DECIDE. The pure ladder, against the mark just updated.
      3. ACT. Only on :data:`RETRY_PUSH`, and only through the existing
         out-of-band path. The attempt is charged BEFORE the spawn, so a
         process that dies mid-push cannot leave the budget untouched and
         retry forever.
    Inputs: session_id (str) - log context only. row_id (int) - the
      sessions primary key, which is the ledger key. title (str | None)
      and claude_title (str | None) - the row's two names AFTER this
      pass's writes. claude_uuid (str | None) - the conversation.
      agent_family (str | None). sync_action
      (str) - this pass's ``TITLE_*`` verdict. now (float | None) - unix
      seconds, injectable for tests. state_dir (Path | None) - injectable
      for tests; resolved from settings when omitted.
    Output: RetryDecision - what was decided, whether or not it acted.
    Example: run_rename_retry(session_id='s', row_id=1, title='A',
      claude_title='A', claude_uuid=None, agent_family=None,
      sync_action='unchanged').verdict -> 'agreed'
    """
    if not retry_enabled():
        return RetryDecision(
            RETRY_DISABLED,
            detail=f"{ENABLE_ENV} is off, so no rename retry ran",
        )

    # KEYED ON THE CONVERSATION AS WELL AS THE ROW. A row id is unique
    # within one database and this ledger outlives any single one of
    # them, and a row re-keyed onto a NEW conversation is a new session
    # whose ordering frame was never witnessed - inheriting the old one
    # would authorise a push on evidence gathered about a different
    # conversation.
    key = f"{claude_uuid or 'none'}:{row_id}"
    at = float(now if now is not None else time.time())
    where = state_dir if state_dir is not None else store.resolve_state_dir()

    agreed = witness_agreement(title=title, claude_title=claude_title)
    mark = store.mark_for(where, key)
    if agreed is not None and (mark is None or mark.agreed_title != agreed
                               or mark.attempted_label is not None):
        mark = record_agreement(mark, agreed)
        store.save_mark(where, key, mark)

    decision = decide_retry(
        sync_action=sync_action,
        title=title,
        claude_title=claude_title,
        mark=mark,
        now=at,
    )
    if decision.verdict != RETRY_PUSH or not decision.label:
        return decision

    if not claude_uuid:
        # The ladder cannot see this: it reasons about names, not about
        # whether the conversation can be addressed. A row with no uuid
        # is the deferral decide_push already names, reported here
        # without spending an attempt on a push that cannot be built.
        return RetryDecision(
            RETRY_PUSH_REFUSED,
            label=decision.label,
            attempts_spent=decision.attempts_spent,
            detail="no conversation uuid is bound, so --resume has nothing to address",
        )

    try:
        return _push(
            session_id=session_id,
            key=key,
            decision=decision,
            claude_uuid=str(claude_uuid),
            agent_family=agent_family,
            mark=mark,
            at=at,
            where=where,
        )
    except Exception as exc:  # noqa: BLE001 - see below
        # DELIBERATE BREADTH, the same posture
        # ``SessionManager._push_rename_to_claude`` takes and for the same
        # reason: this runs on the watcher's tick, where every
        # notification on the machine is raised, and a stuck NAME is not
        # worth costing a session its status. The push reaches a version
        # probe, a binary resolver and a subprocess, so the failure
        # surface is wider than the three types caught inside ``_push``.
        # Caught HERE rather than around the whole function so a bug in
        # the ladder still surfaces.
        logger.warning(
            "rename_retry_push_threw",
            session_id=session_id,
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return RetryDecision(
            RETRY_PUSH_REFUSED,
            label=decision.label,
            attempts_spent=decision.attempts_spent,
            detail=f"the push raised and was contained: {exc}",
        )


def _push(
    *,
    session_id: str,
    key: str,
    decision: RetryDecision,
    claude_uuid: str,
    agent_family: Optional[str],
    mark,
    at: float,
    where: Optional[Path],
) -> RetryDecision:
    """Run the out-of-band rename for an authorised decision.

    Description: the impure half, split out so the function above reads
      as the three-step shape it is. Reaches ``claude_rename`` for every
      part of the push, including the version probe, so this module owns
      no policy about what claude accepts.
    Inputs: session_id (str), key (str) - the ledger key. decision
      (RetryDecision) - already :data:`RETRY_PUSH`. claude_uuid (str).
      agent_family (str | None). mark (RenameMark | None). at (float) -
      unix seconds. where (Path | None) - the state directory.
    Output: RetryDecision.
    Example: see :func:`run_rename_retry`.
    """
    from src.core.claude_rename import (
        PUSH_SENT,
        decide_push,
        detect_claude_version,
        oob_rename_argv,
        spawn_oob_rename,
    )
    from src.core.session_transcript_presence import CONVERSATION_PRESENT

    label = str(decision.label)
    try:
        outcome, reason = decide_push(
            label=label,
            claude_uuid=claude_uuid,
            claude_version=detect_claude_version(),
            is_claude_session=_families_agree(agent_family),
            # THE FILE WAS READ THIS PASS. A RETRY_PUSH verdict is only
            # reachable through TITLE_UNCHANGED, which required the tail
            # read to return a custom-title, so the transcript is present
            # by measurement rather than by assumption. Reporting it as
            # `unchecked` would be true but weaker than what was actually
            # established.
            transcript_presence=CONVERSATION_PRESENT,
        )
    except (ImportError, OSError, ValueError) as exc:
        logger.warning(
            "rename_retry_decide_failed", session_id=session_id, error=str(exc)
        )
        return RetryDecision(
            RETRY_PUSH_REFUSED,
            label=label,
            attempts_spent=decision.attempts_spent,
            detail=f"the push could not be decided: {exc}",
        )

    if outcome != PUSH_SENT:
        logger.info(
            "rename_retry_push_refused",
            session_id=session_id,
            outcome=outcome,
            reason=reason,
            note="no attempt spent; the cloudecode label is stored either way",
        )
        return RetryDecision(
            RETRY_PUSH_REFUSED,
            label=label,
            attempts_spent=decision.attempts_spent,
            detail=reason,
        )

    try:
        from src.core.server_status import collect_claude_cli

        claude_path = (collect_claude_cli() or {}).get("path")
    except (ImportError, OSError) as exc:
        logger.debug(
            "rename_retry_binary_unresolved", session_id=session_id, error=str(exc)
        )
        claude_path = None
    if not claude_path:
        return RetryDecision(
            RETRY_NO_BINARY,
            label=label,
            attempts_spent=decision.attempts_spent,
            detail="the claude binary could not be resolved, so nothing was run",
        )

    # CHARGED BEFORE THE SPAWN. A crash between the two must cost an
    # attempt rather than none: an uncharged failure is an unbounded
    # retry wearing a bound.
    store.save_mark(where, key, record_attempt(mark, label=label, now=at))
    spawn_oob_rename(oob_rename_argv(claude_path, claude_uuid, label), session_id=session_id)
    logger.info(
        "rename_retry_pushed",
        session_id=session_id,
        row_id=key,
        attempt=decision.attempts_spent + 1,
        note="retry of a browser rename that had not reached claude",
    )
    return RetryDecision(
        RETRY_PUSH,
        label=label,
        attempts_spent=decision.attempts_spent + 1,
        detail=decision.detail,
    )
