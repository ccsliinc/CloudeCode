"""Open a session's attention claims without the hook stream.

WHY THIS EXISTS. ``SessionActivityTracker``'s permission and notice
claims used to be opened by feeding it a ``PermissionRequest`` or
``Notification`` hook event. That writer, ``record_event``, was deleted
on 2026-09-13 with the rest of the hook subsystem: the events arrived
under a PANE-WIDE session id that every background agent also posted
under, so the state machine they fed was mislabeled at its source.

The claim store itself survived, because its READERS did. The view seam
(``session_view_clears``) retires both claims when the user looks at a
session, and the pane re-verify
(``session_permission_verify_apply.verify_open_permission``) reads the
permission stamp to decide whether a session is worth one
``capture-pane``. Both of those are live, and both are tested against an
OPEN claim - so the tests need a way to put one there.

WHAT THIS IS NOT. It is not a replacement writer and nothing in ``src``
imports it. It installs the dataclass the readers read, which is exactly
the state they will see once a passive writer supplies one. The rules
``record_event`` enforced about WHEN a claim opens - stamp the
transition and never the duplicate, retire on the three clearing kinds -
went with it, and the tests for those rules went too rather than being
re-expressed against a writer that no longer exists.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from src.core.session_activity import SessionActivitySignal


def open_claims(
    holder: Any,
    session_id: str,
    *,
    permission: bool = False,
    notice: bool = False,
    at: Optional[datetime] = None,
) -> SessionActivitySignal:
    """Put one session's attention claims into the open state.

    Description: accepts either a ``SessionActivityTracker`` or a
      ``SessionManager``, because tests reach for whichever they already
      have in hand, and resolving that here keeps the reach into
      ``_signals`` in ONE place rather than in every suite.
    Inputs:
      holder: a SessionActivityTracker, or a SessionManager carrying one.
      session_id: the id the claims are keyed under.
      permission: open a permission claim.
      notice: open a notice claim.
      at: the naive-UTC stamp dating an opened permission. Required in
        practice whenever ``permission`` is True - a claim with no stamp
        is not a dated claim, and the pane re-verify keys its throttle on
        the stamp.
    Output: the installed SessionActivitySignal, so a caller can assert
      against the exact object the readers will see.
    Example: open_claims(mgr, "ses_1", permission=True, at=T0)
    """
    tracker = getattr(holder, "_activity_tracker", holder)
    signal = SessionActivitySignal(
        permission_open=permission,
        permission_opened_at=at if permission else None,
        notice_open=notice,
    )
    tracker._signals[session_id] = signal
    return signal
