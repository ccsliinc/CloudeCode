"""RESTARTING a stopped session: what it carries, and what it cannot be.

THE BUG THIS EXISTS FOR. The launchpad's RESTART control on a stopped
session built its request from ``working_dir`` and ``agent_type`` and
nothing else. The row's TITLE was never even put into the button's
markup, and its ``session_uuid`` was in the dataset but never passed to
the handler. So restarting a session the user had named, and had been
talking to for hours, produced an unnamed blank console in the right
directory - it discarded identity the client was already holding.

A RESTART CANNOT BE A RESURRECTION, AND THAT PART WAS ALREADY RIGHT.
``POST /sessions/respawn`` puts a process back into a tmux session that
still EXISTS, and it works because ``remain-on-exit`` kept the pane, its
id and its scrollback alive. A session whose tmux is gone has none of
that: there is no pane to put a process into, and ``#{session_created}``
for the replacement is necessarily a new epoch, so the identity triple
``(tmux_socket, tmux_name, tmux_created_epoch)`` cannot match the old
row and must not be made to. Creating fresh is the correct ACTION. What
was wrong is that it threw away everything it knew while doing it.

WHY THE REPLACEMENT RESUMES WITH ``--fork-session`` AND NOT A BARE
``--resume``. A bare resume continues the SAME Claude session uuid, and
``ux_sessions_claude_uuid`` is a UNIQUE partial index - the new row would
collide with the stopped row that still legitimately carries that uuid,
and the collision would surface as an IntegrityError from a hook-driven
telemetry write, which is the one path in this codebase that must never
disturb a live session. ``--fork-session`` makes the CLI mint a NEW uuid
off the same conversation: the history is carried forward, the new row
gets its own identity, and Claude Code itself reports ``source: "fork"``
so ``session_lineage`` classifies it correctly with no help from us.
This is the exact mechanism ``session_fork`` already proved, and its
argument builder is reused rather than copied.

THE LINEAGE THAT IS RECORDED, AND WHY IT IS NOT A NEW ``fork_kind``.
The replacement row gets ``parent_session_id`` pointing at the row it
replaced, and ``fork_kind = 'fork'`` - via ``session_fork.mark_as_fork``,
unchanged. A 'restart' kind was considered and rejected: ``fork_kind``'s
documented vocabulary is Claude Code's own ``SessionStart.source``, and
it answers HOW the new conversation came out of the old one. The
measured answer is ``fork``, because that is literally the flag that was
passed. "The user pressed RESTART on a dead session" is a fact about the
GUI gesture, not about the conversation, and it is already recoverable
without inventing a value: the parent row's lifecycle is ``stopped``,
which is exactly what distinguishes this from a fork of a live session.
Writing 'restart' there would put a UI verb in a column that holds a CLI
measurement.

THE TITLE IS CARRIED VERBATIM, WITH NO ``(fork)`` SUFFIX. A fork branches
a session that is still running, so both need distinguishing and the
suffix earns its place. A restart REPLACES a session that is gone; there
is nothing to distinguish it from, and appending a marker would rename
the user's own label for a reason that does not apply to them.

THREE OUTCOMES, AND THE MIDDLE ONE IS THE POINT. A stopped row with no
``claude_session_uuid`` has no conversation to resume - most of them,
since a session that never reached a Claude ``SessionStart`` never
learned one. The replacement is still created (the user asked for it,
and the working directory, agent and NAME are all still worth carrying)
but the caller is told plainly that no conversation was resumed. It must
never be reported the same way as a resumed one: silently starting a
blank session while implying continuity is the false green this whole
codebase is built against.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any, Dict, Optional

import structlog

from src.core.session_label import label_from_tmux_name
from src.core.session_store import sessions_table_ready

logger = structlog.get_logger()

#: SUCCESS. The replaced row was found and carries a Claude conversation,
#: so the replacement can resume it.
RESTART_RESUMABLE = "resumable"

#: SUCCESS, AND HONESTLY DIMINISHED. The row was found and carries NO
#: ``claude_session_uuid``. A replacement is still created - carrying the
#: title, working directory and agent - but it starts a NEW conversation
#: and the user is told so. NEVER reported as :data:`RESTART_RESUMABLE`.
RESTART_NO_CONVERSATION = "no-conversation"

#: COULD NOT EVALUATE. No datastore, no row with this ``session_uuid``, or
#: the sessions table predates this schema. We cannot say whether there is
#: a conversation to resume, so we do not say. Never folded into either
#: outcome above.
RESTART_UNRESOLVED = "unresolved"


@dataclass(frozen=True)
class RestartSource:
    """Everything the replacement inherits, plus how confident we are.

    Description: the return of :func:`resolve_restart_source`. Frozen
      because it is a measurement of a stored row, not a working value.

      - ``outcome``: one of the three constants above.
      - ``parent_id``: ``sessions.id`` of the row being replaced, for the
        lineage stamp. Present for both success outcomes.
      - ``claude_session_uuid``: the conversation to resume. Present ONLY
        on RESTART_RESUMABLE - its absence IS the other outcome.
      - ``title``: the label the user gave the session. Carried verbatim.
      - ``working_dir`` / ``agent_type`` / ``model`` / ``project_id``: the
        launch context, exactly as the fork path carries them.
      - ``detail``: why, for the outcomes that are not RESUMABLE.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    outcome: str
    parent_id: Optional[int] = None
    claude_session_uuid: Optional[str] = None
    title: Optional[str] = None
    working_dir: Optional[str] = None
    agent_type: Optional[str] = None
    model: Optional[str] = None
    project_id: Optional[int] = None
    detail: Optional[str] = None


def resolve_restart_source(
    conn: sqlite3.Connection, *, session_uuid: str
) -> RestartSource:
    """Read the row a RESTART is replacing, as three outcomes.

    Description: keyed on ``session_uuid``, the DURABLE external identity,
      and deliberately not on the tmux name the fork path uses. A tmux
      name is reusable - this app re-mints them itself - so resolving a
      STOPPED session by name risks matching a LIVE session that took the
      name afterwards and forking that one instead. The uuid cannot do
      that: it is unique and it names exactly the row the user clicked.

      It does not filter on lifecycle. The client already gates the
      control on ``lifecycle === 'stopped'`` and the route re-checks
      nothing here, because a row's stored lifecycle is a snapshot and
      refusing on a stale one would block a restart the user can plainly
      see is needed. What this function promises is only that the row it
      describes is the row that was asked for.
    Inputs: conn (sqlite3.Connection). session_uuid (str) - the stopped
      row's durable identity, from the button's ``data-uuid``.
    Output: RestartSource.
    Example:
      resolve_restart_source(conn, session_uuid="s-1").outcome
    """
    if not sessions_table_ready(conn):
        return RestartSource(
            RESTART_UNRESOLVED,
            detail="datastore predates the sessions table",
        )
    if not session_uuid:
        return RestartSource(
            RESTART_UNRESOLVED,
            detail="no session_uuid was supplied, so no row can be named",
        )
    row = conn.execute(
        "SELECT id, claude_session_uuid, working_dir, title, tmux_name, "
        "agent_type, model, project_id FROM sessions "
        "WHERE session_uuid = ? LIMIT 1",
        (session_uuid,),
    ).fetchone()
    if row is None:
        return RestartSource(
            RESTART_UNRESOLVED,
            detail=f"no stored session with session_uuid {session_uuid!r}",
        )
    data: Dict[str, Any] = dict(row)
    # THE DISPLAY NAME, not the raw tmux handle. A row with no title falls
    # back to its tmux name with this app's "cloude_" prefix stripped -
    # the same derivation the fork path uses, for the same reason: an
    # internal prefix leaking into the one string a human reads.
    title = data.get("title") or label_from_tmux_name(data.get("tmux_name"))
    uuid = data.get("claude_session_uuid")
    if not uuid:
        return RestartSource(
            RESTART_NO_CONVERSATION,
            parent_id=data["id"],
            title=title,
            working_dir=data.get("working_dir"),
            agent_type=data.get("agent_type"),
            model=data.get("model"),
            project_id=data.get("project_id"),
            detail=(
                "this session never recorded a Claude conversation, so "
                "there is nothing to resume. The replacement keeps the "
                "name, directory and agent, and starts a NEW conversation."
            ),
        )
    return RestartSource(
        RESTART_RESUMABLE,
        parent_id=data["id"],
        claude_session_uuid=uuid,
        title=title,
        working_dir=data.get("working_dir"),
        agent_type=data.get("agent_type"),
        model=data.get("model"),
        project_id=data.get("project_id"),
    )
