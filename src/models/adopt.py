"""Adopting a tmux session this app did not create, and listing what
is adoptable on the socket.
"""

from typing import Optional
from pydantic import BaseModel, Field
from .sessions import Session


# Track 1 - Adopt-external-session models.
#
# ``AttachableSession`` is the shape of each row in the launchpad "Adopt an
# external session" list. ``AdoptSessionRequest`` is the POST body for the
# adopt endpoint; ``confirm_detach`` is the explicit consent flag required
# when an active session already exists (409-on-false semantics). The prior
# session is DETACHED - tmux keeps running, the user can re-adopt it from
# the launchpad list later. Destruction only happens via the explicit
# destroy button, never as a side effect of switching sessions. The
# response embeds the existing ``Session`` model plus a base64-encoded
# scrollback blob (binary-safe over JSON) and the FIFO byte offset the WS
# tailer must seek to so the client never sees a scrollback-vs-stream
# duplicate or gap.
class AttachableSession(BaseModel):
    """A tmux session on our socket that the UI may adopt.

    ``created_by_cloude`` is True iff this session is OURS, resolved from
    ``sessions.origin`` on the tmux INSTANCE triple (socket, name,
    creation epoch) - both ``created`` and ``adopted`` count, per design
    section 4.6. False means ``observed``: a session on our socket we have
    never claimed, which is the intended adopt target. Resolving on the
    instance rather than the name is what stops a reused tmux name from
    inheriting a dead session's badge.
    """
    name: str = Field(..., description="Literal tmux session name")
    # The user-facing LABEL for this instance. Distinct from ``name``,
    # which is the tmux handle: the label is what the user called the
    # session and may contain spaces and punctuation the tmux name
    # cannot. None means the row carries no label, and the client falls
    # back to ``name`` exactly as it always did.
    label: Optional[str] = Field(
        default=None,
        description="User-facing session label; falls back to name when None",
    )
    created_by_cloude: bool = Field(
        ..., description="True if Cloude Code created this session"
    )
    created_at_epoch: int = Field(
        ..., description="tmux session creation time (Unix epoch seconds)"
    )
    window_count: int = Field(..., description="Number of windows in the session")
    # Phase 6 - agent label for adopt-list rows. None until Phase 7 wires
    # the fingerprint detector. The launchpad treats None as "unknown"
    # and shows a neutral chip.
    agent_type: Optional[str] = Field(
        default=None,
        description="Detected agent CLI type for this tmux session (None = not yet fingerprinted)",
    )
    # feat/agent-family-pills - see SessionInfo.agent_family /
    # agent_family_source for the full contract. For attachable rows
    # ``agent_type`` is currently always None (listing never runs the
    # fingerprint detector - only adopt does), so these presently always
    # resolve to (None, "unknown"); computed via the same
    # ``resolve_family_for_display`` rather than duplicated so the two
    # payload shapes can never disagree about the same session.
    agent_family: Optional[str] = Field(
        default=None,
        description="Resolved family name for display, or None if it could not be determined",
    )
    agent_family_source: Optional[str] = Field(
        default=None,
        description=(
            "Provenance of agent_family: 'wrapper' | 'reserved_name' | "
            "'fingerprint' | 'derived_deepest' | 'unknown'."
        ),
    )
    # See SessionInfo.agent_wrapper_label for the full contract. Same
    # resolver, so a row merged from either endpoint agrees about which
    # wrapper started the session.
    agent_wrapper_label: Optional[str] = Field(
        default=None,
        description="Configured label of the launch wrapper, or None if none can be named",
    )
    # SESSION-IDENTITY-V2 - pinned theme for this attachable session. None
    # = no pin. Discovery code populates from the active SessionManager
    # state when the row matches the active backend; otherwise None.
    pinned_theme: Optional[str] = Field(
        default=None,
        description="Theme id pinned to this session (None = no pin)",
    )
    # Session sidebar + status lights - resolved via
    # ``src.core.session_status.resolve_pane_status()`` from a single bulk
    # ``tmux list-panes -a`` query. One of "running" | "idle" | "dead" |
    # "unknown". Defaults to "unknown" for any legacy caller that doesn't
    # thread a status map through (never fabricated).
    # feat/hook-driven-status - attachable rows have no live session_id, so
    # no hook signal is ever possible for them (see
    # SessionManager.list_attachable_sessions); this is the tmux-fallback
    # subset of the unified vocabulary: 'dead' | 'working' |
    # 'finished_unread' | 'idle' | 'unknown' (never 'question', 'notice'
    # or 'working_subagent' - those require a live hook stream).
    # THE DURABLE ROW ID, shown bottom-right on the home screen so a
    # human can point at a session and follow a fork tree. Declared HERE
    # and not only produced by the enricher: this is a response_model,
    # which is a FILTER - a field the model does not name is silently
    # DELETED from every response, even when the server had it the whole
    # way up to serialization. That exact defect has hit this file more
    # than once (themeCss, the audio-config block), and the symptom is a
    # value that provably exists upstream and never arrives.
    #
    # OPTIONAL, AND None IS A REAL ANSWER, not a gap: an EXTERNAL tmux
    # session the app never created has no row, so it has no id. The UI
    # renders nothing there rather than inventing a number.
    session_row_id: Optional[int] = Field(
        None,
        description="sessions.id for this instance; None when we have no row",
    )
    parent_session_id: Optional[int] = Field(
        None,
        description="sessions.id this one was forked from; None = not a fork",
    )
    status: str = Field(
        default="unknown",
        description=(
            "Activity status (tmux-fallback subset): 'dead' | 'working' | "
            "'finished_unread' | 'idle' | 'unknown'"
        ),
    )
    # feat/hook-driven-status - persisted unread flag (name-keyed, survives
    # detach/re-adopt). See SessionInfo.unread for the live-session twin.
    unread: bool = Field(
        default=False,
        description="True if this tmux session has an unread Stop or a manual unread pin",
    )
    # THREE-OUTCOME RULE - provenance of the listing this row came out of.
    # A row that EXISTS was always produced by a probe that ran, so these
    # default to the answered case; they are carried anyway so a client
    # holding a single row can tell what kind of listing produced it
    # without threading the envelope alongside. The "could not evaluate"
    # outcome has no rows at all by construction and is reported by the
    # route as HTTP 503 with an ``AttachableListingStatus`` body - see
    # ``GET /sessions/attachable``.
    listing_ok: bool = Field(
        default=True,
        description="True when the tmux probe that produced this row actually ran",
    )
    listing_reason: Optional[str] = Field(
        default=None,
        description=(
            "Why the listing turned out the way it did: null = listed "
            "normally, 'no_server' = tmux reported no server (a real zero), "
            "'not_applicable' = non-tmux backend"
        ),
    )


class AttachableListingStatus(BaseModel):
    """The body of a "could not determine the session list" response.

    Returned as the ``detail`` of an HTTP 503 from
    ``GET /sessions/attachable`` when the tmux probe did not produce an
    answer. It deliberately carries no ``sessions`` array: the whole
    point is that we do not know what the sessions are, and shipping an
    empty one alongside a failure flag invites a client to read the
    array and ignore the flag - which is how this bug shipped the first
    time.

    ``listing_ok`` is always False here. A successful listing is the
    plain ``List[AttachableSession]`` 200 response instead.
    """
    listing_ok: bool = Field(
        default=False,
        description="Always False - this model exists only for the unknown case",
    )
    listing_reason: str = Field(
        ...,
        description=(
            "Machine-readable cause: 'tmux_missing' | 'timeout' | "
            "'probe_error' | 'exit_<returncode>'"
        ),
    )
    listing_detail: Optional[str] = Field(
        default=None,
        description="Human-readable detail (trimmed tmux stderr or exception text)",
    )
    message: str = Field(
        default="tmux session listing could not be determined",
        description="Display string for a client that has no reason mapping",
    )


class AdoptSessionRequest(BaseModel):
    """Request body for ``POST /sessions/adopt``."""
    session_name: str = Field(
        ..., description="Literal tmux session name to adopt"
    )
    confirm_detach: bool = Field(
        False,
        description=(
            "Explicit consent to detach from an already-active session "
            "before adopting. The prior session's tmux pane stays alive "
            "on the socket and can be re-adopted later. Required (must "
            "be True) when a session is live; the server returns 409 "
            "otherwise."
        ),
    )
    # Client-measured terminal dims, same contract as CreateSessionRequest
    # and the rejoin path's ``getSession(includeScrollback, cols, rows)``.
    #
    # An externally-created tmux session is born 80x24 and, because this
    # app never attaches a tmux CLIENT, nothing ever resizes it. Adopting
    # one without these left the pane at 80x24 while an app-created
    # session on the same socket was 163x46. Supplied together or not at
    # all; the pane is reshaped BEFORE its scrollback is captured, so the
    # captured bytes are emitted at the width the client will render them.
    cols: Optional[int] = Field(
        None,
        description="Client-measured terminal columns (xterm cell grid width)"
    )
    rows: Optional[int] = Field(
        None,
        description="Client-measured terminal rows (xterm cell grid height)"
    )


class AdoptSessionResponse(BaseModel):
    """Response body for ``POST /sessions/adopt``.

    ``initial_scrollback_b64`` is base64-encoded raw pane bytes captured at
    adopt time - the client decodes and paints into xterm BEFORE opening
    the WebSocket. ``fifo_start_offset`` is the byte offset the server's
    WS tailer seeks to on first read, so post-adopt live bytes resume
    exactly where the painted scrollback ended (no duplicate, no gap).
    """
    session: Session = Field(..., description="The adopted session record")
    initial_scrollback_b64: str = Field(
        ...,
        description=(
            "Base64-encoded scrollback bytes captured from the tmux pane at "
            "adopt time. May be empty if capture returned nothing."
        ),
    )
    fifo_start_offset: int = Field(
        ...,
        description=(
            "Byte offset into the pipe-pane FIFO recorded immediately after "
            "pipe-pane became active. WS tailer seeks here on first read."
        ),
    )
