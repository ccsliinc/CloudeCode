"""Typed notification events.

Privacy contract (Plan v3.1 correction #2 - ntfy privacy):
- ``session_slug`` is INTERNAL ONLY. It MUST NOT appear in any
  ntfy-bound field (Title, Body, Tags). The slug DOES appear in the
  Click URL - that's an accepted trade-off (Plan v3.1 CUT 6 reverted
  the nonce indirection); threat model is LAN-only behind Tailscale.
- ``snippet`` is INTERNAL ONLY (debug logging). It also MUST NOT be
  sent to ntfy.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional
from urllib.parse import quote


class EventType(str, Enum):
    """All notification kinds the IdleWatcher / lifecycle can emit."""

    PERMISSION_PROMPT = "permission_prompt"
    INPUT_REQUIRED = "input_required"
    TASK_COMPLETE = "task_complete"
    ERROR = "error"
    BUILD_COMPLETE = "build_complete"
    TEST_RESULT = "test_result"
    # v0.7.0 Part 3/4 - Claude Code lifecycle hook kinds, sourced from the
    # hook endpoint via ``session_manager.record_toast``. Distinct from the
    # IdleWatcher's pattern-derived kinds so a Slack/ntfy presentation
    # table can render them with hook-specific copy.
    CLAUDE_STOP = "claude_stop"
    CLAUDE_NOTIFICATION = "claude_notification"
    CLAUDE_PERMISSION_REQUEST = "claude_permission_request"


@dataclass
class NotificationEvent:
    """A single notification to dispatch.

    Attributes:
        kind: classification - drives Title/Priority/Tags selection.
        session_slug: internal-only identifier (filesystem-safe slug
            of the active project). Used to compose the Click URL deep
            link; NEVER placed in Title/Body/Tags.
        timestamp: ``time.monotonic()`` value at emit-site. Used for
            internal latency metrics and rate-limit decisions; not
            sent on the wire.
        snippet: optional last line of output, truncated to 200 chars.
            Internal logging only - NEVER sent to ntfy. The IdleWatcher
            (Item 7) can populate this for its own debug trail.
        policy_key: the DURABLE session identity (``sessions.session_uuid``)
            this event belongs to, or None when the producer does not know
            it. Internal only; never sent to any channel. It is what the
            router looks the notification-mute policy up by - see
            ``src.core.session_notification_policy``. Deliberately NOT
            ``session_slug``: a slug is derived from a tmux name, names are
            reused, and a mute must never transfer to whichever session
            holds a name now.
        policy_generation: the session's notification-policy generation as
            it stood when this event was ENQUEUED. The router refuses to
            send an event whose generation is no longer current, which is
            what stops an alert queued before a mute from arriving after
            it, and stops a muted backlog replaying on unmute. None means
            the producer knew the session but not its generation, and only
            the mute half of the gate applies.
        policy_verdict: what the policy said at STAMP time - one of
            ``src.core.session_notification_policy.ALL_POLICY_VERDICTS``,
            or None. None is the load-bearing value: it means this
            producer does not participate in the mute gate at all, and
            such an event is always sent.

            THE REASON THIS FIELD EXISTS RATHER THAN JUST ``policy_key``
            IS THE ``unknown`` CASE. A policy that could not be read
            yields no session uuid, so a key-only stamp would be
            indistinguishable from "this producer knows nothing about
            sessions" - and that reads as "send it", which is exactly the
            outcome an unreadable mute must never produce. Carrying the
            verdict separates "could not look" from "nothing to look up".

    UNSTAMPED EVENTS ARE ALWAYS SENT. Every policy field defaults to None,
    so a producer that has no session identity to offer is unaffected by
    the gate. Dropping those would silently retire a channel rather than
    mute a session.
    """

    kind: EventType
    session_slug: str
    timestamp: float
    snippet: str = ""
    policy_key: Optional[str] = None
    policy_generation: Optional[int] = None
    policy_verdict: Optional[str] = None


def build_deep_link(
    event: NotificationEvent,
    public_base_url: Optional[str],
) -> Optional[str]:
    """Compose the Click-header URL for a notification.

    Args:
        event: the notification carrying the session_slug.
        public_base_url: e.g. ``"http://mac.lan:8000"``. When unset
            (empty string or None) returns None - caller MUST omit the
            Click header rather than send a bogus URL.

    Returns:
        ``"{public_base_url}/session/{slug-urlencoded}"`` or None.

    Defense in depth:
    - `session_slug` is already sanitized by `_slugify()` at the
      `TmuxBackend` call site, but we re-apply the same rules here so
      an in-process caller that constructs `NotificationEvent` directly
      (tests, future code paths) can never ship an unsafe slug to the
      push channel.
    - `quote()` with `safe=""` encodes EVERY non-alphanumeric, so even
      if the slug regex were loosened we could not smuggle `?`, `#`,
      `/`, or `..` into the deep link.
    """
    if not public_base_url:
        return None
    # Re-slugify defensively - ASCII-only, tmux-legal, never empty.
    # Local import to avoid a circular dependency (tmux_backend imports
    # from src.core.session_backend which is in the same package tree).
    from src.core.tmux_backend import _slugify

    safe_slug = _slugify(event.session_slug)
    # Strip trailing slashes so we don't double-up.
    base = public_base_url.rstrip("/")
    # quote() with safe="" so ALL non-alphanumerics get encoded - slugs
    # are normally URL-safe, but encoding defensively means a hostile
    # slug can't sneak query params or fragments into the deep link.
    encoded_slug = quote(safe_slug, safe="")
    return f"{base}/session/{encoded_slug}"
