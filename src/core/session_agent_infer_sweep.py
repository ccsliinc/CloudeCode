"""Fill every live pane's agent in one pass, at boot and on an adoption.

THE PATH THAT REACHES A HOOKLESS HAND-STARTED SESSION, which measured on
live 2026-09-08 is most of them: ``CLOUDECODE_SESSION_ID`` and
``CLOUDECODE_HOOK_TOKEN`` are copied into a pane's process at spawn, so a
claude the user started by hand inside an already-running pane has
neither and its hooks never arrive attributed. 10 of the hand-started
``not_launched`` sessions on the owner's box have never fired one and
never will. A ladder hung on the first hook would have been a rung that
can never fire for exactly the population it was written for.

Kept apart from ``session_agent_infer_apply`` because the two paths have
opposite cost shapes and opposite memo rules, and folding them together
is how one would inherit the other's gating by accident. The per-session
path runs on every ``PreToolUse`` and is memoised hard; this one runs
twice in a server's life and deliberately re-reads, because the thing it
is looking for - a claude typed into a pane by hand - appears AFTER any
earlier refusal about that pane. Both write through the same WHERE clause
in ``persist_inferred_agent_type``, so neither can write twice and
neither can overwrite a launch.

TWO SUBPROCESSES FOR THE WHOLE FLEET, and only if a row needs them: one
``list-panes -a`` (``TmuxBackend.list_pane_status_all``, which already
carries the name, epoch, pane pid and ``#{pane_current_command}``) and
one ``ps -A``, both taken once and walked in memory. A fleet with nothing
to fill spends no ``ps`` at all, because the row gate runs first.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Callable, Optional, Sequence, Tuple

import structlog

from src.core.claude_resume_argv import (
    ProcessRow,
    find_claude_commands_in_tree,
    list_process_table,
)
from src.core.session_agent_infer import (
    INFER_FAMILY,
    INFER_WRAPPER,
    resolve_agent_inference,
)
from src.core.session_agent_infer_apply import (
    _row_gate,
    configured_wrappers,
    persist_inferred_agent_type,
)

logger = structlog.get_logger()


def sweep_live_sessions(
    session_manager: Any,
    *,
    table_reader: Callable[[], Optional[Sequence[ProcessRow]]] = list_process_table,
    wrappers_reader: Callable[[], Sequence] = configured_wrappers,
) -> Tuple[int, int]:
    """Run the ladder over every live pane at once, and fill what it can.

    Description: THE PATH THAT REACHES A HOOKLESS HAND-STARTED SESSION -
      see the module docstring for why that is most of them. Two
      subprocesses for the entire fleet, not two per pane: one
      ``list-panes -a`` (``TmuxBackend.list_pane_status_all``, which
      already carries the name, the epoch, the pane pid and
      ``#{pane_current_command}`` this needs) and one ``ps -A``. Every
      row is then decided in memory.

      NO PANE PID PROBE. The bulk listing already reports the pid, so the
      per-session ``display-message`` the hook path uses is not issued
      here at all - which is what keeps the whole sweep at two
      subprocesses rather than one per session.

      NEVER RAISES. A sweep is telemetry for a display pill; a boot that
      failed because of one would be a far worse bug than an unfilled
      row.
    Inputs: session_manager (SessionManager) - for the probe backend and
      a writable connection. table_reader (callable), wrappers_reader
      (callable) - injected for tests; both default to the real thing.
    Output: (int, int) - (panes examined, rows written).
    Example: sweep_live_sessions(mgr)  # (19, 0)
    """
    examined = 0
    written = 0
    conn = None
    try:
        rows = _live_pane_rows(session_manager)
        if not rows:
            return 0, 0
        socket = session_manager._tmux_socket_name()
        conn = session_manager._writable_datastore_connection()
        if conn is None:
            return 0, 0

        table = None
        wrappers = None
        for pane in rows:
            name = pane.get("name")
            epoch = pane.get("created_at_epoch")
            if not name or epoch is None:
                continue
            session_uuid = _row_gate(
                conn, socket=str(socket), name=str(name), epoch=int(epoch)
            )
            if session_uuid is None:
                continue
            examined += 1
            # THE SUBPROCESS IS PAID FOR ONLY IF A ROW NEEDS IT, and then
            # only once for the whole sweep. A fleet with nothing to fill
            # spends no `ps` at all.
            if table is None:
                table = table_reader()
                wrappers = wrappers_reader()
            pane_pid = pane.get("pid")
            read = table is not None
            claude_argv = None
            if read and pane_pid is not None:
                commands = find_claude_commands_in_tree(int(pane_pid), table)
                claude_argv = commands[0] if commands else None
            inference = resolve_agent_inference(
                claude_argv=claude_argv,
                pane_current_command=pane.get("pane_current_command"),
                process_table_read=read and pane_pid is not None,
                wrappers=wrappers or (),
            )
            if (
                inference.outcome in (INFER_WRAPPER, INFER_FAMILY)
                and inference.agent_type
                and persist_inferred_agent_type(
                    conn,
                    session_uuid=session_uuid,
                    agent_type=inference.agent_type,
                    family_source=str(inference.family_source),
                    agent_family="claude",
                )
            ):
                written += 1
            logger.info(
                "agent_type_inferred",
                tmux_name=name,
                via="sweep",
                outcome=inference.outcome,
                agent_type=inference.agent_type,
                candidates=list(inference.candidates),
                detail=inference.detail,
            )
        logger.info(
            "agent_infer_sweep_complete", examined=examined, written=written
        )
        return examined, written
    except Exception as exc:  # noqa: BLE001 - see the module docstring
        logger.warning("agent_infer_sweep_failed", error=str(exc))
        return examined, written
    finally:
        if conn is not None:
            try:
                conn.close()
            except sqlite3.Error:  # noqa: BLE001 - closing is not a verdict
                pass


def _live_pane_rows(session_manager: Any) -> Sequence[dict]:
    """One bulk tmux listing of every pane on the dedicated socket.

    Description: reuses ``TmuxBackend.list_pane_status_all``, which is
      already THE bulk pane read in this codebase and already returns the
      four fields the sweep needs. A listing that did not answer yields
      an empty sequence, which the sweep treats as "nothing measured" -
      never as "no panes".
    Inputs: session_manager (SessionManager).
    Output: Sequence[dict] - rows with ``name``, ``created_at_epoch``,
      ``pid`` and ``pane_current_command``.
    Example: _live_pane_rows(mgr)[0]['name']  # 'cloude_api'
    """
    from src.config import settings
    from src.core.session_backend import build_backend
    from src.core.tmux_listing import coerce_listing

    probe = build_backend(
        settings,
        session_id="__agent_infer_probe__",
        working_dir=Path.home(),
        on_output=None,
    )
    if not hasattr(probe, "list_pane_status_all"):
        return ()
    listing = coerce_listing(probe.list_pane_status_all())
    if not listing.ok:
        # NOT "no panes". A listing that did not answer is the third
        # outcome, and the sweep must write nothing on it.
        logger.warning("agent_infer_sweep_listing_unavailable")
        return ()
    return listing.sessions or ()
