"""The one seam between the listing pass and the permission-pane check.

Everything that needs tmux or mutable state happens here; the ladder and the
matcher stay pure in ``session_permission_verify`` and are tested without a
tmux server. Same split, and the same reasons, as
``session_startup_gate`` / ``SessionManager._startup_gate_for``.

IT RUNS BEFORE ``resolve()``, NOT AFTER. A verdict computed after the status
string was built would need the status recomputing or patching, and a patched
status is a second place that decides what the light says. Clearing the flag
first means ``SessionActivityTracker.resolve`` sees the corrected state and
produces the answer on its own, so there is still exactly one resolver.

NEVER RAISES. A listing poll must not fail because one pane could not be read,
and a permission light is not worth a 500 on the home screen.

STEADY STATE COSTS NOTHING, AND THAT WAS CHECKED RATHER THAN CLAIMED.
``should_capture_permission_tail`` is FAIL-CLOSED at every refusal: a session
with no open claim and no stamp is refused, so a box with no dialog on any
pane spends no subprocess here at all. That is the opposite of the startup
gate's equivalent refusal, which was fail-OPEN and cost 13 of 13 healthy
sessions a capture per poll. The one cost that WAS real is the re-look - both
verdicts that keep the flag leave the gate passing next poll - and
``session_permission_verify_ledger`` bounds it without touching the first
look at any claim.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

import structlog

from src.core.session_permission_verify import (
    PERMISSION_CLEARED_NO_DIALOG,
    PERMISSION_CLEARED_PANE_DEAD,
    PERMISSION_NOT_CHECKED,
    PERMISSION_TAIL_LINES,
    resolve_permission_check,
    should_capture_permission_tail,
)
from src.core.session_permission_verify_ledger import ledger_for

logger = structlog.get_logger(__name__)

#: Errors a pane read or a tracker poke can raise that must not end a
#: listing poll. Deliberately enumerated rather than a blanket
#: ``except Exception``: an AttributeError here means this module is
#: talking to a manager shape it does not understand, which is a bug that
#: should be visible in the log rather than swallowed as "no dialog".
_VERIFY_ERRORS = (OSError, ValueError, TypeError, AttributeError)


def verify_open_permission(
    manager: Any,
    *,
    session_id: str,
    backend: Any,
    tmux_name: Optional[str],
    pane_alive: Optional[bool],
    now: Optional[datetime] = None,
) -> str:
    """Corroborate one session's open permission claim against its pane.

    Description: reads the tracker's open-permission stamp, asks the cost
      gate whether this session is worth a ``capture-pane``, and on the
      rare yes runs exactly one capture and applies the verdict. The ONLY
      state it may change is ``permission_open`` on this session, and it
      may only ever clear it - nothing here can invent a permission that
      no hook reported.

      ``permission_flag_cleared_no_dialog`` is logged exactly once per
      episode without any extra bookkeeping, because clearing the flag
      also drops the stamp, and the cost gate then refuses every later
      poll until a NEW ``PermissionRequest`` opens a new claim.

      A PANE MEASURED DEAD (``pane_alive is False``, a real reading that
      says dead - never ``None``, which means no reading happened) is
      cleared directly, with no tail capture, because a dead pane cannot
      show a dialog and there is nothing left to read a tail from. Before
      this branch a permission flag left open at the instant its pane
      died could never be retired: no capture-pane could run against it,
      so it stayed ``question`` forever with no reachable event able to
      clear it - the same stuck-bit shape GOTCHA 10 names for an id
      split, here for a pane that is simply gone. ``None`` still falls
      through to the cost gate below and KEEPS the flag exactly as
      before: not having measured liveness is not evidence the dialog is
      gone.
    Inputs:
      manager: the SessionManager (read for its activity tracker).
      session_id: the id the tracker keys this signal under.
      backend: this session's backend, read for its tmux socket name.
      tmux_name: literal tmux session name, or None when unresolvable.
      pane_alive: True/False/None from the caller's liveness read.
      now: injectable clock, naive UTC. Defaults to ``datetime.utcnow()``.
    Output:
      str - one of the ``PERMISSION_*`` verdicts. ``not_checked`` whenever
      nothing was measured, which includes every error path.
    Example:
      verify_open_permission(mgr, session_id='ses_1', backend=b,
          tmux_name='cloude_a', pane_alive=True)
    """
    tracker = getattr(manager, "_activity_tracker", None)
    if tracker is None or not tmux_name:
        return PERMISSION_NOT_CHECKED

    now = now or datetime.utcnow()

    try:
        opened_at = tracker.permission_open_since(session_id)

        if pane_alive is False:
            # MEASURED DEAD, not unmeasured. No capture is possible or
            # needed - a dead pane has no dialog, so the flag (if any is
            # even open) clears on this measurement alone. See the
            # docstring above; ``None`` never reaches this branch.
            if opened_at is not None and tracker.clear_permission(session_id):
                logger.info(
                    "permission_flag_cleared_pane_dead",
                    session_id=session_id,
                    tmux_name=tmux_name,
                    open_seconds=round(
                        (now - opened_at).total_seconds(), 1
                    ),
                )
                return PERMISSION_CLEARED_PANE_DEAD
            return PERMISSION_NOT_CHECKED

        # THE THROTTLE IS ON THE RE-LOOK ONLY, and it is keyed on the
        # CLAIM rather than on the session, so a new PermissionRequest
        # always gets an immediate first look. See the ledger's module
        # docstring for why a session-keyed record would have delayed
        # exactly the case this verification exists for.
        ledger = ledger_for(manager)
        if not should_capture_permission_tail(
            pane_alive=pane_alive,
            permission_open=opened_at is not None,
            opened_at=opened_at,
            now=now,
            last_check_at=ledger.last_check_at(session_id, opened_at),
        ):
            return PERMISSION_NOT_CHECKED

        socket_name = getattr(backend, "socket_name", None)
        if not socket_name:
            # Nothing to capture THROUGH. A refusal, not a failed read -
            # see the ``captured`` argument on resolve_permission_check.
            return PERMISSION_NOT_CHECKED

        # Imported here, not at module scope, so this module stays
        # importable (and unit-testable) without dragging in tmux_backend.
        from src.core.session_startup_gate_ledger import capture_pane_tail

        tail = capture_pane_tail(
            socket=socket_name, name=tmux_name, lines=PERMISSION_TAIL_LINES
        )
        # Recorded only once a capture has ACTUALLY happened, so a
        # refusal above can never start a throttle window.
        ledger.record_check(session_id, opened_at, now=now)
        verdict = resolve_permission_check(captured=True, tail=tail)

        if verdict == PERMISSION_CLEARED_NO_DIALOG:
            if tracker.clear_permission(session_id):
                logger.info(
                    "permission_flag_cleared_no_dialog",
                    session_id=session_id,
                    tmux_name=tmux_name,
                    open_seconds=round(
                        (now - opened_at).total_seconds(), 1
                    ),
                )
        return verdict
    except _VERIFY_ERRORS as exc:
        logger.warning(
            "permission_verify_failed",
            session_id=session_id,
            tmux_name=tmux_name,
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return PERMISSION_NOT_CHECKED
