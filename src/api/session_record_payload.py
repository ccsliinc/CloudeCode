"""Turn a stored sessions row into the ``SessionRecord`` the API publishes.

Pure mapping, shared by the records list and the recent list, which is
the whole reason it is not inside either of them: two copies of this
would drift, and the first symptom would be one screen showing a family
or a project the other does not.

``agent_family`` here is a DISPLAY resolution and it travels with its
SOURCE, because a fingerprinted guess must never render like a launch
fact. See ``src/core/agent_family_display.py``.
"""

from src.core.agent_family_display import resolve_family_for_display
from src.core.session_manager import _configured_wrappers
from src.models import SessionRecord
from typing import Optional



# --- feat/sessions-table (S4) ----------------------------------------------
# Appended, not woven into the routes above. These two read the STORED
# sessions table; every route before them reads live process state. The
# separation is deliberate: a stored row exists whether or not anything is
# attached to it, which is the only way RECENT can show a stopped session.


def _family_name_for_row(row: dict) -> Optional[str]:
    """The family to display for a STORED session row.

    Description: prefers a stored ``agent_family`` when a row carries one,
      and otherwise resolves it from ``agent_type`` through the ordinary
      display resolver - the same one every live surface uses, so an
      ended session and a running one cannot disagree about what they
      are.

      Returns None rather than guessing when neither can answer. That
      renders as "unknown", which is honest for a row whose agent_type
      was never recorded (adopted sessions, mostly) and is a different
      fact from a family that was knowable all along and simply not
      looked up.
    Inputs: row (dict) - a ``sessions`` row.
    Output: str | None - the family name, or None if unresolvable.
    Example: _family_name_for_row({"agent_type": "claude"}) -> 'claude'
    """
    stored = row.get("agent_family")
    if stored:
        return str(stored)
    agent_type = row.get("agent_type")
    if not agent_type:
        return None
    try:
        wrappers = _configured_wrappers()
    except Exception:  # noqa: BLE001 - a config read must not blank the pill
        wrappers = []
    family, _source = resolve_family_for_display(str(agent_type), wrappers)
    return family.name if family else None


def _session_record_payload(row: dict) -> SessionRecord:
    """Project one sessions row onto the wire model.

    Description: one place that maps DB columns to wire fields, so the
      ``owned`` flag cannot be computed differently by two routes - the
      ownership badge was already hand-repaired across three sites once,
      and that is precisely how the original bug survived.
    Inputs: row (dict) - a ``sessions`` row from session_store.
    Output: SessionRecord.
    """
    from src.core.session_store import is_owned_origin

    return SessionRecord(
        session_uuid=str(row.get("session_uuid")),
        origin=str(row.get("origin")),
        owned=is_owned_origin(row.get("origin")),
        adopted_at=row.get("adopted_at"),
        tmux_socket=row.get("tmux_socket"),
        tmux_name=row.get("tmux_name"),
        tmux_created_epoch=row.get("tmux_created_epoch"),
        lifecycle=str(row.get("lifecycle")),
        lifecycle_checked_at=row.get("lifecycle_checked_at"),
        lifecycle_source=row.get("lifecycle_source"),
        project_id=row.get("project_id"),
        project_attribution=str(row.get("project_attribution")),
        working_dir=row.get("working_dir"),
        agent_type=row.get("agent_type"),
        # RESOLVE FROM agent_type WHEN THE COLUMN IS NULL, which it is on
        # every row ever written - `sessions.agent_family` is declared and
        # never populated. A LIVE session hid that, because its family is
        # resolved at runtime from the in-memory Session; the moment a
        # session ends there is no Session left, this row is all there is,
        # and the UI rendered "unknown family" for a session whose
        # agent_type was sitting in the very same row.
        #
        # Same shape as the cldl picker defect: the answer was present and
        # the layer above asked the wrong object for it.
        agent_family=_family_name_for_row(row),
        agent_family_source=row.get("agent_family_source"),
        model=row.get("model"),
        archived_at=row.get("archived_at"),
        title=row.get("title"),
        # See SessionRecord's lineage block in src/models.py for why all
        # five travel together: no one of them classifies a row on its
        # own, and shipping a subset would leave the client guessing at
        # exactly the distinction they exist to make.
        id=row.get("id"),
        parent_session_id=row.get("parent_session_id"),
        fork_kind=row.get("fork_kind"),
        created_at=row.get("created_at"),
        last_seen_running_at=row.get("last_seen_running_at"),
        # The client orders its session lists by this. ``.get`` because a
        # database that has not reached v23 has no such column, and that
        # absence must arrive as None - "no work recorded" - rather than
        # as a KeyError out of a listing route.
        last_work_at=row.get("last_work_at"),
        # THE DURABLE MUTE. ``.get`` with a falsy default for the same
        # reason ``last_work_at`` uses ``.get``: a database that has not
        # reached v26 has no such column. False is the RIGHT answer there
        # rather than a placeholder - a mute can only be recorded in this
        # column, so a database without it holds no mutes.
        notifications_muted=bool(row.get("notifications_muted")),
        notification_policy_generation=int(
            row.get("notification_policy_generation") or 0
        ),
    )
