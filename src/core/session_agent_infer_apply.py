"""Run the agent inference once per pane, and write at most one row.

The seam between the pure ladder in :mod:`src.core.session_agent_infer`
and the two impure things it needs: the pane's process evidence, and the
datastore. It exists as its own module for the reason
``claude_title_sync_apply`` does - the rules stay testable with no
subprocess and no database, and ``session_manager.py`` does not grow
another body of logic.

THE HOOK IS ONE TRIGGER OF THREE, AND IT IS THE ONE THAT CANNOT REACH THE
SESSIONS THIS FEATURE EXISTS FOR. Measured on live 2026-09-08: 10 of the
hand-started ``not_launched`` sessions have never fired a hook AND NEVER
WILL. ``CLOUDECODE_SESSION_ID`` and ``CLOUDECODE_HOOK_TOKEN`` are copied
into a pane's process at spawn (see ``TmuxBackend.respawn``'s
``set-environment`` ordering), so a claude the user started by hand inside
an already-running pane has neither, and its hooks either never fire or
cannot be attributed. A ladder hung on the first hook would therefore have
been unreachable for exactly the population it was written for - a rung
that can never fire, which this repo's CLAUDE.md names as its own trap.

So the evidence read is driven three ways, and NONE of them is the
evidence itself:

  the boot re-adopt   ``session_agent_infer_sweep.sweep_live_sessions``,
                      once, over every
                      surviving pane. This is what reaches a hookless
                      hand-started session, and it is where the standing
                      population is picked up.
  an adoption         the same sweep, after a pane is adopted.
  a hook              :func:`apply_agent_inference` for that one session.
                      Still worth having: it fires the instant a session
                      that DOES have the env starts working, without
                      waiting for a restart.

A HOOK IS STILL THE STRONGEST EVIDENCE WHEN IT EXISTS, and nothing here
weakens that: a hook proves a claude is running before any process is
read. What changed is that its ABSENCE is no longer read as an absence of
claude, because on this fleet it usually is not.

WHY THE PER-EVENT PATH IS GATED SO HARD. It runs on every hook event,
including ``PreToolUse`` and ``PostToolUse``, which fire on every single
tool call. A ``ps -A`` per tool call would be exactly the kind of "small"
cost this codebase has already paid for once with ``PRAGMA
integrity_check`` on the version endpoint. So the work is gated twice:

  * an in-process memo keyed on the tmux INSTANCE, so the whole pass runs
    at most once per pane per server process, whatever it decided; and
  * a cheap row read FIRST - one indexed SELECT - which ends the pass for
    every session that already carries an ``agent_type``. On a box whose
    sessions were all launched by the app, that is the entire cost, once,
    and no subprocess is ever spawned.

THE MEMO IS KEYED ON THE INSTANCE, NOT THE SESSION ID. A confirmed live
restart keeps the session id and the epoch and moves only the pane pid,
and a new session under a reused name has a new epoch - the same identity
rule ``StartupGateLedger`` uses, for the same reason. A ``None`` epoch is
never memoised: there is no instance to key, so nothing may be remembered
about it.

WHY AN ATTEMPT IS MEMOISED HERE AND NOT IN THE SWEEP. Every refusal in the per-event ladder is a measurement
of a pane whose process tree does not change between two hooks a second
apart, so retrying it per tool call would spend a subprocess to re-derive
the same refusal forever. The SWEEP is the opposite case: it costs TWO
subprocesses for the whole fleet however many panes there are, it runs at
boot and on an adoption rather than on a timer, and the thing it is
looking for - a claude typed into a pane by hand - appears LATER than any
earlier refusal about that pane. So it re-reads, and only the row gate
stops it. Both paths write through the same WHERE clause, so neither can
write twice.

IDEMPOTENCE DOES NOT DEPEND ON THE MEMO. The write's own WHERE clause
requires ``agent_type`` to be empty, which the first successful write
makes false - so a second pass, in this process or the next one, is a
guaranteed no-op rather than a re-derivation. The memo is a cost control;
the WHERE clause is the correctness guarantee.

NEVER RAISES. This runs on the hook endpoint's critical path and what it
produces is a display pill. Every failure becomes a named outcome the
caller may log and ignore.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any, Callable, Optional, Sequence, Set, Tuple

import structlog

from src.core.claude_resume_argv import (
    ProcessRow,
    find_claude_commands_in_tree,
    list_process_table,
)
from src.core.db_models import SESSION_FAMILY_SOURCE_LAUNCHED
from src.core.session_agent_infer import (
    AgentInference,
    INFER_FAMILY,
    INFER_WRAPPER,
    UNAVAILABLE,
    resolve_agent_inference,
)

logger = structlog.get_logger()

#: Outcome: this instance was already decided in this process. No read of
#: any kind was taken.
APPLY_ALREADY_TRIED: str = "already_tried"

#: Outcome: the row already carries an ``agent_type``, or records a
#: LAUNCH this app performed. Nothing to infer and nothing to correct -
#: the cheap gate that keeps a healthy box free of subprocess cost.
APPLY_ALREADY_RECORDED: str = "already_recorded"

#: Outcome: no instance could be keyed (no tmux name, no epoch, no row),
#: or the datastore could not be opened. NOT a statement about the pane.
APPLY_NO_INSTANCE: str = "no_instance"

#: Outcome: the ladder ran. ``inference`` carries what it decided and
#: ``written`` whether a row actually moved.
APPLY_RAN: str = "ran"


@dataclass(frozen=True)
class InferApplyResult:
    """What one inference pass did.

    Description: read ``outcome`` first; ``inference`` is set only for
      :data:`APPLY_RAN`. ``written`` is True only when a row was actually
      updated, which is at most once per pane for the life of the row.
    Inputs (constructor): outcome (str) - one of the ``APPLY_*``
      constants. inference (AgentInference | None) - the ladder's verdict.
      written (bool) - whether the UPDATE changed a row.
    Output: an InferApplyResult instance.
    Example: apply_agent_inference(mgr, 'ses_1', 'cloude_x').outcome
    """

    outcome: str
    inference: Optional[AgentInference] = None
    written: bool = False


#: Instances this process has already decided, as (socket, name, epoch).
#: Bounded in practice by the number of panes on one tmux server; see
#: the module docstring for why an attempt and not only a success is
#: recorded here.
_TRIED: Set[Tuple[str, str, int]] = set()


def reset_memo() -> None:
    """Forget every instance this process has already decided.

    Description: for tests only. Production has no reason to re-run a
      pass whose evidence cannot have changed; a real change of contents
      means a new process, and a new server means a new set.
    Inputs: none.
    Output: None.
    Example: reset_memo()
    """
    _TRIED.clear()


def read_pane_process_evidence(
    pane_pid: Optional[int],
    *,
    table_reader: Callable[[], Optional[Sequence[ProcessRow]]] = list_process_table,
) -> Tuple[bool, Optional[str]]:
    """Snapshot the process table and find the pane's claude command line.

    Description: THE ONE IMPURE READ in this feature, behind one function
      so a test can fake it without a real ``ps``. One ``ps -A`` call for
      the whole table (macOS has no ``/proc``), walked in memory, reusing
      ``claude_resume_argv``'s tree walk rather than writing a second one
      - both topologies a pane can have (the pane pid IS claude, or claude
      is a descendant of the pane's shell) are covered by that walk.

      THE TWO FAILURE SHAPES ARE KEPT APART BY THE FIRST RETURN VALUE. A
      False means the table could not be read, which is not a finding
      about the pane; a True with a None command line means the table WAS
      read and holds no claude for this pane, which is.
    Inputs: pane_pid (int | None) - the pane's foreground pid. None
      answers ``(False, None)``: with no root there is nothing to walk,
      so nothing was measured.
      table_reader (callable) - returns a process-table snapshot or None.
      Injected for tests; defaults to the real ``ps`` reader.
    Output: (bool, str | None) - (was the table read, the claude command
      line found in this pane's tree).
    Example: read_pane_process_evidence(4821) -> (True, 'claude --chrome')
    """
    if pane_pid is None:
        return False, None
    try:
        table = table_reader()
    except Exception as exc:  # noqa: BLE001 - a probe must never raise
        logger.warning("agent_infer_process_table_failed", error=str(exc))
        return False, None
    if table is None:
        return False, None
    commands = find_claude_commands_in_tree(int(pane_pid), table)
    return True, (commands[0] if commands else None)


def _row_gate(
    conn: sqlite3.Connection, *, socket: str, name: str, epoch: int
) -> Optional[str]:
    """Is this instance's row still unresolved enough to infer for?

    Description: the cheap gate, one indexed SELECT on the instance
      triple. A row that already names an agent, or that records a launch
      THIS APP performed with an agent, has nothing to infer. A
      ``not_launched`` row does: the app really did start no agent, and
      the human then typed one into the pane, which is punchlist 3 in one
      sentence.
    Inputs: conn (sqlite3.Connection). socket (str), name (str),
      epoch (int) - the instance triple.
    Output: str | None - the row's ``session_uuid`` when it may be
      filled, None when it may not (already recorded, no row, or the
      table could not be read).
    """
    try:
        row = conn.execute(
            "SELECT session_uuid, agent_type, agent_family_source "
            "FROM sessions WHERE tmux_socket = ? AND tmux_name = ? "
            "AND tmux_created_epoch = ?",
            (socket, name, int(epoch)),
        ).fetchone()
    except sqlite3.Error as exc:
        logger.warning(
            "agent_infer_row_read_failed",
            tmux_name=name,
            error=str(exc),
            note="reported as no-instance; nothing is claimed about the pane",
        )
        return None
    if row is None:
        return None
    data = dict(row)
    if (data.get("agent_type") or "").strip():
        return None
    if (data.get("agent_family_source") or "") == SESSION_FAMILY_SOURCE_LAUNCHED:
        return None
    return str(data.get("session_uuid") or "") or None


def persist_inferred_agent_type(
    conn: sqlite3.Connection,
    *,
    session_uuid: str,
    agent_type: str,
    family_source: str,
    agent_family: str,
) -> bool:
    """Write an inferred agent onto one row, once, and never over a fact.

    Description: the write half. Three conditions live in the single
      UPDATE's WHERE clause rather than in a SELECT-then-UPDATE, so there
      is no window for a real launch to land between the read and the
      write:

        ``agent_type`` empty            an inference may only FILL, never
                                        replace. This is also what makes
                                        the write idempotent for free -
                                        the first success makes it false.
        source is not ``launched``      the one source that means the app
                                        chose and ran a command. Belt and
                                        braces beside the column test,
                                        because the two are written
                                        together and a future half-write
                                        must not be able to slip past
                                        both.
        the row exists                  by ``session_uuid``, the external
                                        identity an inference always has
                                        in hand after the gate.

      ``agent_family`` is written alongside ``agent_type`` because the
      PAIR is what a reader renders, and this project has already paid
      for a half-write that moved one column of a pair and left the other
      contradicting it (see ``session_project_binding``'s
      ``columns_to_write``).
    Inputs: conn (sqlite3.Connection) - caller owns the transaction.
      session_uuid (str) - the row's external identity.
      agent_type (str) - a configured wrapper id or the bare family name.
      family_source (str) - ``inferred_process``.
      agent_family (str) - the resolved family, ``claude`` here.
    Output: bool - True iff a row was actually written. Every failure is
      a no-op returning False, never a raise: this cannot be allowed to
      break the hook delivery that triggered it.
    Example: persist_inferred_agent_type(conn, session_uuid='a',
        agent_type='claude-chrome', family_source='inferred_process',
        agent_family='claude')
    """
    if not session_uuid or not agent_type or not family_source:
        return False
    try:
        cursor = conn.execute(
            "UPDATE sessions SET agent_type = ?, agent_family = ?, "
            "agent_family_source = ? WHERE session_uuid = ? "
            "AND (agent_type IS NULL OR agent_type = '') "
            "AND agent_family_source != ?",
            (
                agent_type,
                agent_family,
                family_source,
                session_uuid,
                SESSION_FAMILY_SOURCE_LAUNCHED,
            ),
        )
        conn.commit()
    except sqlite3.Error as exc:
        logger.warning(
            "agent_infer_persist_failed",
            session_uuid=session_uuid,
            agent_type=agent_type,
            error=str(exc),
            note="best-effort write; hook delivery is unaffected",
        )
        return False
    return cursor.rowcount > 0


def configured_wrappers() -> Sequence:
    """The user's launch wrappers, read through the one sanctioned accessor.

    Description: delegates to ``session_manager._configured_wrappers``,
      which is THE place this config is read for display resolution and
      which already documents why a hand-rolled attribute chain here
      would silently return an empty list forever. Imported lazily
      because ``session_manager`` imports this module. A config that will
      not load answers an empty list, which makes every wrapper match
      impossible and lands the ladder on the bare family - a worse but
      honest answer, never an invented one.
    Inputs: none.
    Output: Sequence - AgentWrapper objects, possibly empty.
    Example: configured_wrappers()
    """
    try:
        from src.core.session_manager import _configured_wrappers

        return _configured_wrappers()
    except Exception as exc:  # noqa: BLE001 - a config read is not a verdict
        logger.warning("agent_infer_wrappers_unavailable", error=str(exc))
        return ()


def apply_agent_inference(
    session_manager: Any,
    session_id: str,
    tmux_name: Optional[str],
    *,
    table_reader: Callable[[], Optional[Sequence[ProcessRow]]] = list_process_table,
    wrappers_reader: Callable[[], Sequence] = configured_wrappers,
) -> InferApplyResult:
    """Infer this pane's agent once, and record it if anything was proven.

    Description: called from ``SessionManager.record_hook_event`` on every
      hook, and structured so the common path costs one memo lookup. The
      order is deliberate and is the whole performance story: memo, then
      the row gate (one SELECT), then the tmux pane pid, then the single
      ``ps``. Nothing below a rung runs when the rung above ends the pass.

      NEVER RAISES - see the module docstring.
    Inputs: session_manager (SessionManager) - for the socket name, the
      instance epoch, a pane-pid probe and a writable connection.
      session_id (str) - the cloudecode session id, used only to look up
      the epoch this process recorded for it. tmux_name (str | None) -
      the pane's tmux session name, already resolved by the caller.
      table_reader (callable) - injected process-table reader, for tests.
      wrappers_reader (callable) - injected wrapper-config reader, for
      tests. Both defaults are the real thing.
    Output: InferApplyResult.
    Example: apply_agent_inference(mgr, 'ses_1', 'cloude_x').outcome
    """
    if not tmux_name:
        return InferApplyResult(APPLY_NO_INSTANCE)

    try:
        socket = session_manager._tmux_socket_name()
        epoch = getattr(session_manager, "_instance_epochs", {}).get(session_id)
    except Exception as exc:  # noqa: BLE001 - never break hook delivery
        logger.warning("agent_infer_identity_failed", error=str(exc))
        return InferApplyResult(APPLY_NO_INSTANCE)

    if epoch is None:
        # NO INSTANCE TO KEY. A name alone is reusable, so neither the
        # memo nor the row read may use one - see the module docstring.
        return InferApplyResult(APPLY_NO_INSTANCE)

    key = (str(socket), str(tmux_name), int(epoch))
    if key in _TRIED:
        return InferApplyResult(APPLY_ALREADY_TRIED)

    conn = None
    try:
        conn = session_manager._writable_datastore_connection()
        if conn is None:
            return InferApplyResult(APPLY_NO_INSTANCE)

        session_uuid = _row_gate(conn, socket=str(socket), name=str(tmux_name), epoch=int(epoch))
        if session_uuid is None:
            # Recorded already, or no row. Either way this instance is
            # settled and re-reading it per tool call buys nothing.
            _TRIED.add(key)
            return InferApplyResult(APPLY_ALREADY_RECORDED)

        _TRIED.add(key)

        from src.core.tmux_session_pane_pid import probe_session_pane_pid

        pane_pid = probe_session_pane_pid(str(tmux_name), socket=str(socket))
        read, claude_argv = read_pane_process_evidence(
            pane_pid, table_reader=table_reader
        )
        pane_current_command = _pane_current_command(session_manager, session_id)

        inference = resolve_agent_inference(
            claude_argv=claude_argv,
            pane_current_command=pane_current_command,
            process_table_read=read,
            wrappers=wrappers_reader(),
        )

        written = False
        if inference.outcome in (INFER_WRAPPER, INFER_FAMILY) and inference.agent_type:
            written = persist_inferred_agent_type(
                conn,
                session_uuid=session_uuid,
                agent_type=inference.agent_type,
                family_source=str(inference.family_source),
                agent_family="claude",
            )
        logger.info(
            "agent_type_inferred",
            tmux_name=tmux_name,
            outcome=inference.outcome,
            agent_type=inference.agent_type,
            candidates=list(inference.candidates),
            written=written,
            detail=inference.detail,
        )
        return InferApplyResult(APPLY_RAN, inference=inference, written=written)
    except Exception as exc:  # noqa: BLE001 - see the module docstring
        logger.warning(
            "agent_infer_pass_failed",
            session_id=session_id,
            tmux_name=tmux_name,
            error=str(exc),
        )
        return InferApplyResult(APPLY_RAN, inference=UNAVAILABLE)
    finally:
        if conn is not None:
            try:
                conn.close()
            except sqlite3.Error:  # noqa: BLE001 - closing is not a verdict
                pass


def _pane_current_command(session_manager: Any, session_id: str) -> Optional[str]:
    """tmux's ``#{pane_current_command}`` for this session, if already known.

    Description: read from the backend the app already holds, never by
      issuing a tmux call of its own. This value only ever CORROBORATES
      (see ``resolve_agent_inference``), so spending a subprocess on it
      would be paying for a signal that cannot select a rung on its own.
      None is the normal answer and costs the ladder nothing.
    Inputs: session_manager (SessionManager). session_id (str).
    Output: str | None.
    Example: _pane_current_command(mgr, 'ses_1') -> 'claude'
    """
    backend = session_manager._registry.get_backend(session_id)
    value = getattr(backend, "pane_current_command", None) if backend else None
    return str(value) if value else None
