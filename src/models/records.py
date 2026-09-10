"""The stored ``sessions`` row on the wire, the first-run import status,
and the recent listing.
"""

from typing import Optional, List
from pydantic import BaseModel, Field


# --- feat/sessions-table (S4) ----------------------------------------------
# The stored ``sessions`` row on the wire, and the status of the one-way
# first-run import. Appended rather than folded into the models above:
# ``SessionInfo`` describes a session the app currently has OPEN, while
# ``SessionRecord`` describes a row that exists whether or not anything is
# attached to it. Conflating them is how RECENT ends up unable to show a
# session that is merely stopped.


class SessionRecord(BaseModel):
    """One row of the ``sessions`` table, as the home screen reads it.

    Every field that can be unmeasured is nullable or carries an explicit
    unknown value. In particular ``lifecycle`` has THREE values and
    ``unknown`` is not a flavour of ``stopped``: it means the tmux probe
    did not answer, and a row in that state offers no lifecycle actions.
    """

    session_uuid: str = Field(..., description="Stable external identity")
    origin: str = Field(
        ...,
        description=(
            "'created' | 'adopted' | 'observed'. The first two are OURS; "
            "'observed' is the only value that renders as external"
        ),
    )
    owned: bool = Field(
        ...,
        description="True when origin is 'created' or 'adopted' (design 4.6)",
    )
    adopted_at: Optional[str] = Field(
        default=None,
        description="When this session was first claimed. Never rewritten",
    )
    tmux_socket: Optional[str] = Field(default=None)
    tmux_name: Optional[str] = Field(default=None)
    tmux_created_epoch: Optional[int] = Field(
        default=None,
        description=(
            "tmux #{session_created}. With socket and name this is the "
            "INSTANCE identity; the name alone is not an identity"
        ),
    )
    lifecycle: str = Field(
        ...,
        description="'running' | 'stopped' | 'unknown' - see design 4.2",
    )
    lifecycle_checked_at: Optional[str] = Field(default=None)
    lifecycle_source: Optional[str] = Field(default=None)
    project_id: Optional[int] = Field(default=None)
    project_attribution: str = Field(
        ...,
        description=(
            "'explicit' | 'derived_deepest' | 'none' | 'unknown'. 'none' "
            "means probed and matched nothing; 'unknown' means we could "
            "not probe. Only 'unknown' is NEEDS ATTENTION"
        ),
    )
    working_dir: Optional[str] = Field(default=None)
    agent_type: Optional[str] = Field(default=None)
    agent_family: Optional[str] = Field(default=None)
    agent_family_source: Optional[str] = Field(
        default=None,
        description="Unresolved renders as UNKNOWN, never as 'claude'",
    )
    model: Optional[str] = Field(default=None)
    archived_at: Optional[str] = Field(
        default=None,
        description="Visibility only. NEVER hides a running session",
    )
    title: Optional[str] = Field(default=None)
    # LINEAGE, SHIPPED SO THE CLIENT CAN TELL A RESTART REPLACEMENT FROM A
    # DELIBERATE FORK. Both write fork_kind='fork' and a parent_session_id
    # (see src/core/session_restart.py's "THE LINEAGE THAT IS RECORDED"
    # block for why no 'restart' kind was invented), so neither field
    # discriminates on its own. What does is WHEN: a restart replaces a
    # session that was ALREADY dead, so the parent's last_seen_running_at
    # precedes the child's created_at by however long it sat stopped,
    # while a fork branches a session that is still RUNNING and whose
    # last_seen_running_at therefore keeps advancing past its child's
    # birth. The client needs all four columns to make that comparison,
    # and `id` because parent_session_id points at sessions.id and
    # nothing else on this model carried it.
    id: Optional[int] = Field(
        default=None,
        description="sessions.id - what parent_session_id points at",
    )
    parent_session_id: Optional[int] = Field(
        default=None,
        description="sessions.id of the row this one branched from",
    )
    fork_kind: Optional[str] = Field(
        default=None,
        description=(
            "Claude Code's own SessionStart.source. NOT a restart marker "
            "- a restart replacement records 'fork' like any other fork"
        ),
    )
    created_at: Optional[str] = Field(default=None)
    last_seen_running_at: Optional[str] = Field(
        default=None,
        description=(
            "When this session was last PROVEN alive by a tmux probe. "
            "None means never - which is a cannot-determine, not a zero"
        ),
    )
    last_work_at: Optional[str] = Field(
        default=None,
        description=(
            "When WORK last happened in this session - stamped only from "
            "a Claude Code hook event that means the conversation did "
            "something (claude_hooks.WORK_EVENTS). NOT an opened time: "
            "attaching, selecting or deep-linking to a session never "
            "moves it. NOT last_seen_running_at, which is a liveness "
            "probe that advances on a session nobody has touched. None "
            "means no work has been recorded - a third outcome, sorted "
            "below every value and labelled, never treated as the epoch"
        ),
    )
    # THE DURABLE MUTE, on the record it actually lives on. Carried here as
    # well as on ``SessionInfo`` because the two payloads answer for
    # different populations: ``SessionInfo`` covers sessions bound to a
    # live backend, this covers every row including stopped and archived
    # ones. A menu rendered from either must agree about the same session,
    # which is the same reason ``agent_family`` and friends are on both.
    notifications_muted: bool = Field(
        default=False,
        description=(
            "True when this row records that its notifications are muted. "
            "False on a database that predates schema v26, where the "
            "column does not exist and nothing can have been muted"
        ),
    )
    notification_policy_generation: int = Field(
        default=0,
        description=(
            "How many times this row's notification policy has changed. "
            "Steps on mute AND unmute; a queued alert stamped with an "
            "older value is refused rather than delivered late"
        ),
    )


class SessionImportStatus(BaseModel):
    """Whether the one-way first-run session import has run, and if not why.

    THREE OUTCOMES. ``state`` is ``completed`` (the latch is stamped),
    ``pending`` (it has not run and MUST retry - typically because the
    tmux probe could not answer), or ``unavailable`` (the datastore
    itself could not be read, so we cannot even say which of the first
    two applies). ``pending`` is never reported as ``completed``, because
    a stamped latch over a failed probe is permanent silent data loss.
    """

    state: str = Field(
        ..., description="'completed' | 'pending' | 'unavailable'"
    )
    imported_at: Optional[str] = Field(
        default=None,
        description="meta.imported_from_json_at. None whenever not completed",
    )
    pending_reason: Optional[str] = Field(
        default=None,
        description="The tmux probe's own reason token, e.g. 'timeout'",
    )
    notice: Optional[str] = Field(
        default=None,
        description=(
            "Sentence for the home screen. Present ONLY when there is "
            "something to act on, so its presence means act"
        ),
    )
    session_count: Optional[int] = Field(
        default=None,
        description="Rows in the sessions table. None when unavailable",
    )


class RecentSessionsResponse(BaseModel):
    """``GET /sessions/recent`` (S9) - the RECENT group, datastore-backed.

    RECENT is every stored row with ``lifecycle='stopped'`` and
    ``archived_at IS NULL`` - no timer, no retention window. Unlike
    every other launcher surface, this one reads the ``sessions`` table
    rather than a live tmux probe.

    THREE OUTCOMES, carried in ``state``, not folded into ``sessions``:
      'ok'                - ``sessions`` reflects the stored rows as of
        this read.
      'probe_unavailable' - the most recent tmux listing probe failed.
        The stored rows are NOT read as stale-but-still-true here:
        RESTART safety depends on trusting that a 'stopped' row really
        is stopped right now, and a currently-broken probe means that
        cannot be confirmed. ``sessions`` is always ``[]``.
      'never_probed'      - no tmux listing probe has run yet this
        process's lifetime, so probe health is itself an unmeasured
        fact. ``sessions`` is always ``[]``, for the same reason as
        'probe_unavailable'.

    Every row in ``sessions`` (state 'ok') carries ``lifecycle='stopped'``
    by construction of the query; a client must still gate any RESTART
    control on that field itself rather than trusting group membership -
    see ``client/js/launchpad.js``'s RECENT renderer.
    """

    state: str = Field(
        ..., description="'ok' | 'probe_unavailable' | 'never_probed'"
    )
    sessions: List[SessionRecord] = Field(default_factory=list)
    notice: Optional[str] = Field(
        default=None,
        description=(
            "Sentence for the home screen, present whenever state != 'ok'"
        ),
    )
