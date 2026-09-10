"""What LOOKING at a session clears, in one place.

MEASURED ON LIVE 2026-09-09, f77a978. The session named BHPP painted the
terracotta ``notice`` light for 46 minutes ACROSS A VISIT: the owner
opened the tab, read it, left, and the light was still asking for
attention. ``notice`` is set by a claude ``Notification`` hook - the one
it fires after about sixty seconds of waiting for input - it outranks the
heartbeat in ``SessionActivityTracker.resolve``, and until now the only
things that cleared it were ``UserPromptSubmit``, ``PreToolUse`` and
``Stop``. All three are the AGENT doing something. None of them is the
user showing up, and "come and look at me" is a claim only the user can
answer.

THE OWNER'S RULE, VERBATIM: "when clicking a tab, the session is marked
read. if i want it unread i click unread." A notification is exactly that
kind of state, so a view clears it, on the same event and through the
same seam that clears the unread flag.

A PERMISSION IS NOW CLEARED TOO, AND THE ASYMMETRY THAT USED TO BE HERE
IS WORTH KEEPING IN THE RECORD. The old rule was that ``question`` is a
fact about the agent rather than a message to the user - it is STOPPED
until a human answers a yes/no - so looking at it does not answer it, and
clearing on a view would be the false-green shape this project keeps
removing. The argument is sound and it was still protecting the wrong
thing.

MEASURED ON LIVE 2026-09-09. ``cloude_Media_Compression`` painted the
permission light with NO dialog on its pane: the tail showed a settings
warning, a typed-but-unsubmitted prompt line and ``bypass permissions
on``. The flag had been set on session id ``ses_949a8585``, while the
claude in that pane was measured to hold
``CLOUDECODE_SESSION_ID=adopted:cloude_Media_Compression`` in its own
process environment - a spawn-time value tmux cannot rewrite into a
running process. So the three events that clear the flag were landing on
a different tracker key and NOTHING REACHABLE FROM THAT PANE COULD EVER
RETIRE IT. A claim no observation can retire is not a careful claim, it
is a stuck bit, and it had been stuck for over an hour across a visit.

So the flag now has two retirement paths, and the owner's rule covers
both: "when clicking a tab, the session is marked read. if i want it
unread i click unread." The user's own eyes are one path, and this is
where it is applied. The other is evidence: while the flag is open past a
grace window, the listing pass reads the pane and clears it when no
dialog is on screen (``src/core/session_permission_verify.py``). The
hook-driven clears are untouched - all three still fire, and they are
still the fastest of the three routes when the ids line up.

NO TIME EXPIRY IS ADDED EITHER, per the owner: "a session left alone
should not go gray. if i dont focus the tab it keeps its color." A
notice is cleared by a person, not by a clock.

WHY THIS IS ITS OWN MODULE. Two call sites want the same thing - a
WebSocket terminal binding (``SessionManager.mark_session_viewed``) and
the user's manual mark-read control (``set_manual_unread(name, False)``)
- and they arrive holding DIFFERENT identifiers: one has a session id and
no tmux name, the other has a tmux name and no session id. Putting the
resolution here means there is exactly one definition of what a view
clears, rather than two that drift.
"""

from __future__ import annotations

from typing import Any, Optional

import structlog

logger = structlog.get_logger(__name__)


def session_ids_for_tmux_name(manager: Any, tmux_name: str) -> list[str]:
    """Every live session id whose backend is bound to one tmux name.

    Description: a tmux name is the durable identity and a session id is
      not, so the mapping is derived from the live backends rather than
      remembered. It returns a LIST, not one id: one pane can carry two
      registrations while an adopt is being re-keyed (see CLAUDE.md's
      ``_registered_ids_for_tmux_name``), and clearing only the first
      would leave the other holding the notice that is actually on
      screen.
    Inputs: manager (SessionManager). tmux_name (str) - literal name.
    Output: list[str] - ids, possibly empty.
    Example: session_ids_for_tmux_name(mgr, 'cloude_BHPP') -> ['ses_1']
    """
    if not tmux_name:
        return []
    backends = getattr(manager, "backends", None) or {}
    return [
        sid
        for sid, backend in backends.items()
        if getattr(backend, "tmux_session", None) == tmux_name
    ]


def clear_view_state(
    manager: Any,
    *,
    session_id: Optional[str] = None,
    tmux_name: Optional[str] = None,
) -> bool:
    """Clear everything that LOOKING at a session resolves. Idempotent.

    Description: drops the whole unread flag (both sub-flags, one write -
      see ``UnreadStore.clear``) and clears BOTH open attention flags on
      the session's activity signal - the notice and the permission. See
      the module docstring for why the permission was excluded until
      2026-09-09 and what measurement changed it. Accepts either identifier and resolves the
      other; a caller that supplies neither, or one that names a session
      with no tmux backend, is a no-op rather than an error, because a
      view must never be able to raise on a socket bind.

      Applying it twice reaches the same state as applying it once: the
      unread store issues no write when there is nothing to drop, and
      clearing a notice that is already clear is a no-op boolean write.
    Inputs: manager (SessionManager). session_id (str | None) - the id a
      WebSocket bind holds. tmux_name (str | None) - the name the manual
      control holds. At least one must be supplied.
    Output: bool - True when a tmux name was resolved and the clear was
      applied, False when nothing could be addressed.
    Example: clear_view_state(mgr, session_id='ses_5a756046')
    """
    ids: list[str] = []
    if session_id:
        ids.append(session_id)

    if not tmux_name and session_id:
        backend = (getattr(manager, "backends", None) or {}).get(session_id)
        tmux_name = getattr(backend, "tmux_session", None) if backend else None

    if tmux_name:
        for sid in session_ids_for_tmux_name(manager, tmux_name):
            if sid not in ids:
                ids.append(sid)

    tracker = getattr(manager, "_activity_tracker", None)
    if tracker is not None:
        for sid in ids:
            tracker.clear_notice(sid)
            # BOTH ATTENTION FLAGS, on every id this pane is registered
            # under. Clearing only the first id would leave the other
            # registration holding the light that is actually on screen -
            # the same reason ``session_ids_for_tmux_name`` returns a list.
            tracker.clear_permission(sid)

    if not tmux_name:
        return False

    store = getattr(manager, "_unread_store", None)
    if store is None:
        return False
    # THE SAME epoch source the Stop writer and the manual control use.
    # A clear derived any other way lands on a key nobody wrote, and the
    # flag becomes unclearable.
    store.clear(tmux_name, manager._unread_epoch(tmux_name))
    logger.debug("session_view_cleared", tmux_name=tmux_name, ids=len(ids))
    return True
