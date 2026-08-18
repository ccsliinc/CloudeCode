"""The WRITE path for a tmux session row: where identity is DECIDED.

Split out of src/core/session_store.py, which keeps the reads. The split
follows the risk rather than the table: every function here can create,
claim or refuse a row, and each of those decisions turns on whether two
things are the SAME tmux process. A read cannot get that wrong. These
three can.

THE THREE DECISIONS, AND WHY THERE ARE THREE.

  INSERT   nothing carries this instance triple. New row, new
           ``session_uuid``, the ``origin`` the caller asserted.
  MERGE    a LIVE row carries it: the same process, seen again. Refresh
           the liveness columns and touch nothing else. ``origin``,
           ``adopted_at`` and ``session_uuid`` are never rewritten,
           because origin is written once and never recomputed (design
           4.6) - an ``observed`` sighting must not demote an ``adopted``
           session.
  REFUSE   a STOPPED row carries it. At ``#{session_created}``'s
           one-second resolution that means a session died and another
           took its name inside the same second, so the stored row cannot
           be the live one in front of us. Overwriting it would hand one
           session's history, and one session's ownership badge, to a
           different process. Nothing is written and a warning naming
           BOTH rows is logged.

The refusal is the entire reason this is three outcomes and not two.
"""

from __future__ import annotations

import sqlite3
import uuid as _uuid
from dataclasses import dataclass
from typing import Any, List, Optional, Tuple

import structlog

from src.core.db_models import (
    SESSION_ATTRIBUTION_UNKNOWN,
    SESSION_FAMILY_SOURCE_UNKNOWN,
    SESSION_LIFECYCLE_RUNNING,
    SESSION_LIFECYCLE_STOPPED,
    SESSION_ORIGIN_ADOPTED,
)
from src.core.session_store import get_instance, sessions_table_ready
from src.core.trail_entry import utc_now

logger = structlog.get_logger()


#: Outcomes of :func:`record_instance`. Three, not two: the third is the
#: refusal, and it must never be reported as either of the first two.
RECORD_INSERTED = "inserted"
RECORD_MERGED = "merged"
RECORD_REFUSED_EPOCH_COLLISION = "refused_epoch_collision"

#: Columns :func:`record_instance` may fill on INSERT. Anything not here
#: keeps its schema default; nothing here is ever overwritten on a merge,
#: because a merge describes the SAME instance and must not rewrite what
#: an earlier, better-informed write already established.
_OPTIONAL_INSERT_COLUMNS: Tuple[str, ...] = (
    "project_id",
    "project_attribution",
    "working_dir",
    "legacy_session_id",
    "agent_type",
    "agent_family",
    "agent_family_source",
    "model",
    "claude_session_uuid",
    "pinned_theme",
    "unread_auto",
    "unread_manual",
    "title",
    "adopted_at",
)


@dataclass(frozen=True)
class RecordResult:
    """What one :func:`record_instance` call did to the table.

    Description: an explicit three-valued outcome so a caller can tell an
      insert from a merge from a REFUSAL. A refusal returning the same
      shape as a success is how a collision would become invisible.
    Inputs (constructor): outcome (str) - one of ``RECORD_INSERTED``,
      ``RECORD_MERGED``, ``RECORD_REFUSED_EPOCH_COLLISION``.
      session_id (int | None) - the row id, None only on a refusal.
      session_uuid (str | None) - the row's external identity.
      detail (str | None) - human-readable reason, set on a refusal.
    Output: a RecordResult instance.
    """

    outcome: str
    session_id: Optional[int] = None
    session_uuid: Optional[str] = None
    detail: Optional[str] = None

    @property
    def refused(self) -> bool:
        """True when the write was refused rather than applied.

        Inputs: none.
        Output: bool.
        """
        return self.outcome == RECORD_REFUSED_EPOCH_COLLISION


def new_session_uuid() -> str:
    """Mint a fresh external session identity.

    Description: one place that decides the format, so the import path,
      the create path and a test cannot disagree about it.
    Inputs: none.
    Output: str - a UUID4 in canonical hyphenated form.
    Example: new_session_uuid()  # '3f2a...'
    """
    return str(_uuid.uuid4())


def record_instance(
    conn: sqlite3.Connection,
    *,
    socket: str,
    name: str,
    epoch: int,
    origin: str,
    lifecycle: str = SESSION_LIFECYCLE_RUNNING,
    lifecycle_source: Optional[str] = None,
    now: Optional[str] = None,
    **fields: Any,
) -> RecordResult:
    """Insert a row for a tmux instance, or reconcile the one already there.

    Description: the single write path for "we have just seen this tmux
      instance". Three outcomes, never two:

      INSERTED  no row carried this triple. A new row is created with a
        fresh ``session_uuid`` and the ``origin`` the caller asserted.

      MERGED    a row carries this triple and is NOT ``stopped``, so it
        describes the same live instance we are looking at. Its liveness
        columns are refreshed. ``origin``, ``adopted_at`` and
        ``session_uuid`` are NEVER touched: origin is written once and
        never recomputed (design 4.6), so an ``observed`` sighting of an
        already-``adopted`` session must not demote it.

      REFUSED   a row carries this triple and IS ``stopped``. At
        one-second epoch resolution that means a session died and another
        took its name inside the same second, so the stored row cannot be
        the live one. Overwriting it would hand one session's history -
        including an adoption the user made - to a different process.
        Nothing is written, a warning naming BOTH rows is logged, and the
        caller gets ``RECORD_REFUSED_EPOCH_COLLISION``.
    Inputs: conn (sqlite3.Connection) - caller owns the transaction.
      socket (str), name (str), epoch (int) - the instance triple.
      origin (str) - one of db_models.SESSION_ORIGINS; applied on INSERT
      only. lifecycle (str) - default ``running``. lifecycle_source
      (str | None). now (str | None) - ISO-8601 stamp, defaults to
      ``utc_now()``; exposed for tests with a fixed clock. **fields - any
      of ``_OPTIONAL_INSERT_COLUMNS``, applied on INSERT only.
    Output: RecordResult.
    Raises: sqlite3.Error - on a pre-v2 database, or a genuine write
      failure. ValueError - an unknown key in ``fields``.
    Example:
        record_instance(conn, socket='cloude', name='a', epoch=1000,
                        origin='observed').outcome  # 'inserted'
    """
    stamp = now or utc_now()
    unknown = set(fields) - set(_OPTIONAL_INSERT_COLUMNS)
    if unknown:
        raise ValueError(
            f"record_instance got unknown column(s): {sorted(unknown)}"
        )

    existing = get_instance(conn, socket=socket, name=name, epoch=epoch)
    if existing is not None:
        return _reconcile_existing(
            conn,
            existing=existing,
            socket=socket,
            name=name,
            epoch=epoch,
            incoming_origin=origin,
            lifecycle=lifecycle,
            lifecycle_source=lifecycle_source,
            stamp=stamp,
        )

    session_uuid = new_session_uuid()
    columns = [
        "session_uuid",
        "tmux_socket",
        "tmux_name",
        "tmux_created_epoch",
        "origin",
        "lifecycle",
        "lifecycle_checked_at",
        "lifecycle_source",
        "created_at",
        "updated_at",
    ]
    values: List[Any] = [
        session_uuid,
        socket,
        name,
        int(epoch),
        origin,
        lifecycle,
        stamp,
        lifecycle_source,
        stamp,
        stamp,
    ]
    if lifecycle == SESSION_LIFECYCLE_RUNNING:
        columns.append("last_seen_running_at")
        values.append(stamp)
    for key in _OPTIONAL_INSERT_COLUMNS:
        if key in fields and fields[key] is not None:
            columns.append(key)
            values.append(fields[key])
    if "project_attribution" not in columns:
        columns.append("project_attribution")
        values.append(SESSION_ATTRIBUTION_UNKNOWN)
    if "agent_family_source" not in columns:
        columns.append("agent_family_source")
        values.append(SESSION_FAMILY_SOURCE_UNKNOWN)

    placeholders = ", ".join("?" for _ in columns)
    cursor = conn.execute(
        f"INSERT INTO sessions ({', '.join(columns)}) VALUES ({placeholders})",
        values,
    )
    return RecordResult(
        outcome=RECORD_INSERTED,
        session_id=int(cursor.lastrowid),
        session_uuid=session_uuid,
    )


def _reconcile_existing(
    conn: sqlite3.Connection,
    *,
    existing: Dict[str, Any],
    socket: str,
    name: str,
    epoch: int,
    incoming_origin: str,
    lifecycle: str,
    lifecycle_source: Optional[str],
    stamp: str,
) -> RecordResult:
    """Refresh a live row's liveness, or refuse a same-epoch collision.

    Description: the branch of :func:`record_instance` taken when the
      triple already has a row. Split out so the refusal is a named piece
      of code with its own log line rather than an early return buried in
      a longer function. The log deliberately names BOTH rows - the
      stored one by id, uuid, origin and adoption stamp, and the incoming
      one by its triple and asserted origin - because a collision that
      only names one of them is not diagnosable.
    Inputs: conn (sqlite3.Connection). existing (dict) - the stored row.
      socket (str), name (str), epoch (int) - the triple. incoming_origin
      (str). lifecycle (str), lifecycle_source (str | None), stamp (str).
    Output: RecordResult - ``merged`` or ``refused_epoch_collision``.
    """
    if existing.get("lifecycle") == SESSION_LIFECYCLE_STOPPED:
        detail = (
            f"stored session id={existing.get('id')} "
            f"uuid={existing.get('session_uuid')} "
            f"origin={existing.get('origin')} "
            f"adopted_at={existing.get('adopted_at')} "
            f"lifecycle=stopped already holds instance "
            f"({socket}, {name}, {epoch}); incoming live instance "
            f"({socket}, {name}, {epoch}) origin={incoming_origin} "
            f"lifecycle={lifecycle} REFUSED, nothing written"
        )
        logger.warning(
            "session_instance_epoch_collision_refused",
            tmux_socket=socket,
            tmux_name=name,
            tmux_created_epoch=int(epoch),
            stored_session_id=existing.get("id"),
            stored_session_uuid=existing.get("session_uuid"),
            stored_origin=existing.get("origin"),
            stored_adopted_at=existing.get("adopted_at"),
            stored_lifecycle=existing.get("lifecycle"),
            incoming_origin=incoming_origin,
            incoming_lifecycle=lifecycle,
            note=(
                "tmux #{session_created} has one-second resolution; a stopped "
                "row cannot be the live instance, so the merge is refused "
                "rather than overwriting another session's history"
            ),
            detail=detail,
        )
        return RecordResult(
            outcome=RECORD_REFUSED_EPOCH_COLLISION,
            session_id=int(existing["id"]),
            session_uuid=existing.get("session_uuid"),
            detail=detail,
        )

    sets = [
        "lifecycle = ?",
        "lifecycle_checked_at = ?",
        "lifecycle_source = ?",
        "updated_at = ?",
    ]
    values: List[Any] = [lifecycle, stamp, lifecycle_source, stamp]
    if lifecycle == SESSION_LIFECYCLE_RUNNING:
        sets.append("last_seen_running_at = ?")
        values.append(stamp)
    values.append(int(existing["id"]))
    conn.execute(
        f"UPDATE sessions SET {', '.join(sets)} WHERE id = ?", values
    )
    return RecordResult(
        outcome=RECORD_MERGED,
        session_id=int(existing["id"]),
        session_uuid=existing.get("session_uuid"),
    )


def adopt_instance(
    conn: sqlite3.Connection,
    *,
    socket: str,
    name: str,
    epoch: int,
    now: Optional[str] = None,
    project_id: Optional[int] = None,
    project_attribution: Optional[str] = None,
    working_dir: Optional[str] = None,
    agent_family_source: Optional[str] = None,
) -> bool:
    """Claim one tmux instance as ours, permanently.

    Description: design section 4.6's adoption statement - one UPDATE,
      keyed on the instance triple so name reuse cannot redirect it onto
      a different process. The caller owns the transaction.

      ADOPTED_AT IS FIRST-WRITE-WINS, AND THAT IS A DECISION, NOT AN
      ACCIDENT. ``adopted_at`` answers "when did this session become
      ours", and that moment is the FIRST claim. Re-running adoption - a
      double-clicked button, a retried request, or the UI re-opening a
      session through the adopt path, which it does routinely - must not
      slide the timestamp forward and rewrite history that already
      happened. Implemented as ``COALESCE(adopted_at, :now)`` so the
      second call is a genuine no-op on that column, and asserted by
      tests/test_session_store.py. The rest of the statement IS
      idempotent-by-overwrite (re-probing a working directory should
      update it); only the moment of the claim is immutable.

      ``origin`` moves to ``adopted`` and never moves again: this
      function is the only writer of that value, and it has no path back
      to ``observed``.
    Inputs: conn (sqlite3.Connection) - caller owns the transaction.
      socket (str), name (str), epoch (int) - the instance triple.
      now (str | None) - ISO-8601 stamp, defaults to ``utc_now()``.
      project_id (int | None), project_attribution (str | None),
      working_dir (str | None), agent_family_source (str | None) - each
      applied only when not None, so a caller that could not probe a
      value leaves the stored one alone rather than nulling it.
    Output: bool - True when a row was updated; False when no row carries
      that triple (nothing was created, and that is the honest answer:
      adopting a session we have no record of is a caller bug, not a
      row to invent).
    Example: adopt_instance(conn, socket='cloude', name='a', epoch=1000)
    """
    if not sessions_table_ready(conn):
        return False
    stamp = now or utc_now()
    sets = [
        "origin = ?",
        "adopted_at = COALESCE(adopted_at, ?)",
        "updated_at = ?",
    ]
    values: List[Any] = [SESSION_ORIGIN_ADOPTED, stamp, stamp]
    for column, value in (
        ("project_id", project_id),
        ("project_attribution", project_attribution),
        ("working_dir", working_dir),
        ("agent_family_source", agent_family_source),
    ):
        if value is not None:
            sets.append(f"{column} = ?")
            values.append(value)
    values.extend([socket, name, int(epoch)])
    cursor = conn.execute(
        f"UPDATE sessions SET {', '.join(sets)} WHERE tmux_socket = ? "
        "AND tmux_name = ? AND tmux_created_epoch = ?",
        values,
    )
    return cursor.rowcount > 0
