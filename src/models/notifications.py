"""Toasts, the mute policy, and what the notification settings screen
reads back.
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class Toast(BaseModel):
    """A toast notification recorded for a session.

    Storage shape: each session keeps a list of these, newest-first, capped
    at ``unacked + last 50 acked``. Created via
    ``SessionManager.record_toast``; acked via ``SessionManager.ack_toast``.
    The ``color`` field is precomputed at record time from the session's
    project theme (``--color-accent`` in the theme manifest's ``cssVars``)
    so the client can paint a per-session-colored left border without an
    extra theme lookup.
    """
    id: str = Field(..., description="UUID4 string")
    session_id: str = Field(..., description="Session this toast belongs to")
    kind: str = Field(
        ...,
        description="Toast kind: 'Stop' | 'PermissionRequest' | 'Notification'",
    )
    title: str = Field(..., description="Short bold headline")
    body: Optional[str] = Field(None, description="Optional longer body text")
    color: Optional[str] = Field(
        None,
        description="Hex accent color resolved from the session's project theme",
    )
    # WHICH SESSION THIS IS ABOUT, IN WORDS, STAMPED AT RECORD TIME.
    # A toast is a record of a moment, not a view of a session: it can
    # arrive for a session that is not on screen, it outlives the session
    # it names, and the attach backfill re-delivers it later. So the
    # client cannot be relied on to still have that session's row when the
    # card renders. The one moment the identity is certainly knowable is
    # this one, while the session is live and in hand.
    #
    # TWO FACTS, NO DECISION. The fallback rule ("label, else the
    # cloude_-stripped tmux name, else say so") lives in exactly one place
    # for the whole app - client/js/session-label.js - so these fields
    # carry what was true and never a pre-resolved display string. Both
    # None means this toast's session cannot be named, which the client
    # renders as "unknown session" rather than dropping the line.
    session_label: Optional[str] = Field(
        None,
        description=(
            "The session's user-facing label at record time; None when it "
            "had none. NOT a display string - the client applies the "
            "fallback."
        ),
    )
    session_name: Optional[str] = Field(
        None,
        description=(
            "The session's tmux name at record time; None for a non-tmux "
            "session. The fallback the client renders when there is no label."
        ),
    )
    created_at: datetime = Field(default_factory=datetime.utcnow)
    # MONOTONIC PER-RECORD VERSION, ISSUE #39. Hook events are unordered,
    # duplicated and droppable, so a client applying whatever arrives last
    # can apply a stale redelivery over a newer state. This is the same
    # discipline client/js/preferences.js already uses for
    # `preferences.changed`: a per-record integer, starting at 1, that
    # moves ONLY on a real content change - never a global counter, never
    # a timestamp (two hook events can share a millisecond).
    # `SessionManager.record_toast` bumps it when a superseded `Stop`'s
    # body/color/label actually differs from what is held, and skips the
    # bump on an identical re-raise (the common case: "your turn" fired
    # twice with nothing new to say). `SessionManager.ack_toast` bumps it
    # on the acked/unacked transition, once, guarded by the same
    # already-acked check that makes that method idempotent.
    #
    # ABSENT IS NOT A DEFAULT FOR A CONSUMER OF THIS FIELD. The default
    # below exists only so every record this server ever mints carries a
    # real version from birth; it must never be read by a client as
    # meaning "version zero" for a record that came from somewhere this
    # field does not reach (an older server, a locally-minted toast that
    # never passed through this model). See toast-lifecycle.js's
    # `_shouldReplace`.
    version: int = Field(
        1,
        description=(
            "Monotonic version of this record, starting at 1. Bumped only "
            "on a real content change (supersession with different body, "
            "or an ack transition), never on a duplicate or reorder of "
            "the same fact. A client compares this, not the id alone, "
            "before replacing a held record: higher replaces, equal is a "
            "no-op, lower is discarded as an out-of-order delivery."
        ),
    )
    acknowledged: bool = Field(
        False, description="True once the toast has been dismissed"
    )
    # WHY IT WAS ACKED, WHICH IS A DIFFERENT FACT FROM WHETHER IT WAS.
    # "I dealt with it" and "it was cleared for me because I turned up"
    # are different things to have happened to a notification, and until
    # this field existed the history could render only open/dismissed and
    # said so out loud (docs/notifications.md open item 2).
    #
    # None ONLY while the record is open. A value is stamped by whatever
    # acked it: ``dismissed`` for a click or a sweep control,
    # ``answered`` for the hook-driven auto-ack in
    # ``src/core/toast_auto_ack.py``. The vocabulary lives in that module
    # so the writer and the reader cannot drift.
    ack_reason: Optional[str] = Field(
        None,
        description=(
            "Why this toast was acknowledged: 'dismissed' (a human "
            "cleared it) or 'answered' (a hook said the user turned "
            "up). None while the toast is still open."
        ),
    )

    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }


class CreateToastRequest(BaseModel):
    """Request body for ``POST /api/v1/sessions/{session_id}/toasts``.

    Synthetic creation endpoint used by v0.7.0 Part 2 testing. Part 3 will
    add a hook-driven endpoint with different auth semantics; this surface
    is INTENTIONALLY kept around so the client and the storage layer have a
    way to be exercised end-to-end without a real Claude Code hook.
    """
    kind: str = Field(
        ...,
        description="Toast kind: 'Stop' | 'PermissionRequest' | 'Notification'",
    )
    title: str = Field(..., description="Short bold headline")
    body: Optional[str] = Field(None, description="Optional longer body text")


class MuteNotificationsRequest(BaseModel):
    """Body of ``PATCH /sessions/records/{session_uuid}/notifications``.

    ``muted`` IS A STATE, NOT A TOGGLE, and that is the whole reason this
    carries a boolean rather than being two verbs. A menu can be clicked
    twice, a request can be retried, and two tabs can be open on the same
    session; a toggle would make every one of those flip the setting to
    whatever the race decided. Sending the state the user asked for makes
    the call idempotent, so a repeat is a no-op that reports the same
    answer instead of undoing the first one.
    """

    muted: bool = Field(
        ...,
        description="The state being requested. Idempotent: not a toggle",
    )
    # THE EXPECTED INSTANCE. A row action is fired from a LIST THAT WAS
    # PAINTED EARLIER, and a tmux name is reusable - so between the paint
    # and the click, the session under that name can have been replaced.
    # Supplying the instance the user was looking at lets the server refuse
    # rather than mute whatever holds the name now, which would be a
    # setting the user never made, applied to a session they never saw, and
    # SILENT: a wrongly muted session announces itself only by the alerts
    # that stop arriving.
    #
    # OPTIONAL, AND THAT IS NOT A LOOPHOLE. ``session_uuid`` is minted once
    # and never reused, so it already addresses exactly one row for good;
    # this pair is a second, narrower check for a caller that has a live
    # instance to name. An archived row has no tmux instance at all and
    # must still be addressable. Both fields must be sent together to be
    # checked - half a key identifies nothing.
    expected_tmux_name: Optional[str] = Field(
        default=None,
        description=(
            "The tmux session name the caller believes this row carries. "
            "Checked only when sent together with the epoch"
        ),
    )
    expected_tmux_created_epoch: Optional[int] = Field(
        default=None,
        description=(
            "tmux #{session_created} for the instance the caller means. "
            "With the name this is the INSTANCE identity"
        ),
    )


class NotificationPolicyResponse(BaseModel):
    """What ``PATCH .../notifications`` committed.

    Both fields are the COMMITTED values read back from the row, never the
    values that were requested. A response that echoed the request would be
    unable to report an idempotent no-op honestly, and the generation is
    the one number a caller must not be allowed to guess: it orders every
    queued notification against this change.
    """

    muted: bool = Field(
        ..., description="The committed mute state on the row"
    )
    policy_generation: int = Field(
        ...,
        description=(
            "The committed policy generation. Steps by one on every real "
            "change, in both directions; unchanged by a no-op"
        ),
    )
