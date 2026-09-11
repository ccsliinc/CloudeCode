"""Decide whether the attach handshake owes the pane a settle pause.

WHAT PROBLEM THIS SOLVES. ``src/api/websocket.py`` slept 150 ms on every
single attach, unconditionally, so that a ``SIGWINCH`` raised by the
handshake resize had time to reach the pane's foreground process and that
process had time to finish whatever ANSI write was in flight before we
captured its screen. That is the right thing to wait for WHEN A RESIZE
ACTUALLY HAPPENED. It is pure latency when the browser reconnects at
exactly the geometry the pane is already at, which is the common case: the
same phone, the same laptop window, coming back to the same session. No
resize is issued, no ``SIGWINCH`` is delivered, and there is nothing to
wait for.

THE RULE HAS THREE OUTCOMES, NOT TWO, AND THE THIRD IS THE WHOLE DESIGN.
A reading that did not happen is not a reading of nothing. The settle is
skipped ONLY on a geometry the pane itself POSITIVELY reported and that
equals what we want it to be. Every other answer - the probe failed, the
backend cannot be asked, the client never sent dims, the resize call
raised - takes the settle exactly as it did before this module existed.
Treating "unknown" as "unchanged" would turn a transient tmux hiccup into
a pane whose grid does not match the browser, and that failure is
invisible until the user types. It is the same asymmetry
``reconcile_instance_epoch`` applies with ``cannot_determine`` and the
same one the startup gate applies at rung 5.

COMPARE AGAINST THE PANE, NEVER AGAINST A CACHE. The size a previous
socket negotiated is not evidence about the pane now: a restart, an
external ``resize-window``, or an adopted session can all have moved it.
``#{pane_width}`` and ``#{pane_height}`` are the only truth, and reading
them costs ONE tmux round trip - measured p50 9.85 ms on a loaded box
against the 150 ms it can save, and against the 22.81 ms the
``resize-window`` plus ``refresh-client`` pair costs on the event loop
when we skip that too.

Measured on tmux 3.6a, throwaway socket, load average 14:

===========================================  ==========
one ``display-message`` geometry probe        p50 9.85 ms
``resize-window`` + ``refresh-client``        p50 22.81 ms
the settle this replaces                      150 ms flat
===========================================  ==========
"""

from __future__ import annotations

import asyncio
from typing import Any, NamedTuple, Optional, Tuple

import structlog

logger = structlog.get_logger()

#: How long the attach handshake pauses after a resize it actually issued.
#: Empirically enough for tmux to deliver SIGWINCH to the pane's foreground
#: process and for that process to finish an in-flight write. Unchanged
#: from the literal it replaced; this module changes WHETHER it is paid,
#: never how long it is.
SETTLE_SECONDS: float = 0.15

#: The one verdict that skips the pause: the pane reported its own
#: geometry and it already equals the geometry we want it at.
REASON_CONFIRMED_UNCHANGED: str = "geometry_confirmed_unchanged"

#: The pane answered and is at a DIFFERENT size, so a resize went out and
#: there is a real SIGWINCH in flight to wait for.
REASON_CHANGED: str = "geometry_changed"

#: The pane could not be asked, or answered something unparseable. Not
#: evidence that nothing moved.
REASON_UNMEASURED: str = "geometry_unmeasured"

#: No negotiated geometry exists to compare against - the client never
#: delivered handshake dims, or the session had no tracked client. There
#: is nothing to confirm, so nothing may be skipped.
REASON_NO_CLIENT_GEOMETRY: str = "no_client_geometry"

#: The resize call itself raised or was reported failed. The pane's state
#: is now unknown, which is the strongest possible reason to wait.
REASON_RESIZE_FAILED: str = "resize_failed"


class ResizeOutcome(NamedTuple):
    """What the handshake resize actually did, as opposed to what it meant to.

    Attributes:
        target: the negotiated (cols, rows) the pane is supposed to end up
            at, or None when no geometry could be negotiated at all.
        issued: True when a backend ``resize`` call was actually made.
            False both when the negotiator had nothing to apply and when
            the pane was measured already at ``target``.
        failed: True when applying the size raised or was reported failed.
    """

    target: Optional[Tuple[int, int]]
    issued: bool
    failed: bool


#: What the fallback branch reports: the client never sent dims, so no
#: resize was attempted and there is no target to compare a reading to.
NO_RESIZE_ATTEMPTED: ResizeOutcome = ResizeOutcome(
    target=None, issued=False, failed=False
)


class SettleVerdict(NamedTuple):
    """Whether to pause, and the one word that says why.

    Attributes:
        settle: True to pause for :data:`SETTLE_SECONDS`.
        reason: one of the ``REASON_*`` constants in this module. It is
            logged, so a slow attach can be attributed without a rebuild.
    """

    settle: bool
    reason: str


def decide_settle(
    measured: Optional[Tuple[int, int]],
    outcome: ResizeOutcome,
) -> SettleVerdict:
    """Decide whether the attach handshake must pause before painting.

    The ladder, in order. Only the last rung skips:

    1. the resize failed -> settle. The pane's geometry is now unknown.
    2. no negotiated target -> settle. Nothing to confirm against.
    3. the pane's geometry was not measured -> settle. Not having looked
       is not evidence nothing moved.
    4. a resize WAS issued -> settle. Something is in flight by
       definition, whatever the pre-resize reading said.
    5. the measured geometry equals the target -> SKIP.

    Rung 4 is belt and braces rather than dead code: rung 5's condition
    and "no resize was issued" are made to agree by the caller, and if a
    future change breaks that agreement this gate closes rather than
    silently skipping a settle a real ``SIGWINCH`` needed.

    Args:
        measured: (cols, rows) the PANE reported for itself before the
            resize, or None when it could not be read.
        outcome: what the resize attempt actually did.

    Returns:
        SettleVerdict: ``settle`` plus the reason it was decided.

    Example:
        >>> decide_settle((100, 40), ResizeOutcome((100, 40), False, False))
        SettleVerdict(settle=False, reason='geometry_confirmed_unchanged')
        >>> decide_settle(None, ResizeOutcome((100, 40), True, False))
        SettleVerdict(settle=True, reason='geometry_unmeasured')
    """
    if outcome.failed:
        return SettleVerdict(True, REASON_RESIZE_FAILED)
    if outcome.target is None:
        return SettleVerdict(True, REASON_NO_CLIENT_GEOMETRY)
    if measured is None:
        return SettleVerdict(True, REASON_UNMEASURED)
    if outcome.issued:
        return SettleVerdict(True, REASON_CHANGED)
    if tuple(measured) != tuple(outcome.target):
        return SettleVerdict(True, REASON_CHANGED)
    return SettleVerdict(False, REASON_CONFIRMED_UNCHANGED)


async def read_pane_geometry(backend: Any) -> Optional[Tuple[int, int]]:
    """Ask a backend for its pane's own (cols, rows), refusing to guess.

    Backends that cannot answer - the legacy ``PTYBackend``, a stand-in, a
    session with no backend at all - simply do not carry
    ``pane_geometry``. They get None here, which lands on the
    "unmeasured" rung and therefore keeps exactly the behaviour they had
    before this module existed.

    Args:
        backend: a session backend, or None.

    Returns:
        (cols, rows) as the pane reports them, or None when the backend
        cannot be asked, refused to answer, or raised. None is never a
        claim about the geometry.

    Example:
        >>> await read_pane_geometry(tmux_backend)
        (163, 46)
    """
    if backend is None:
        return None
    probe = getattr(backend, "pane_geometry", None)
    if probe is None:
        return None
    try:
        result = probe()
        if asyncio.iscoroutine(result):
            result = await result
    except (OSError, ValueError, RuntimeError) as exc:
        # A probe that raised told us nothing. Log it and refuse: the
        # caller's ladder reads None as "settle", which is the behaviour
        # this whole path had before the fast path existed.
        logger.debug("pane_geometry_probe_failed", error=str(exc))
        return None
    if result is None:
        return None
    try:
        cols, rows = result
        return (int(cols), int(rows))
    except (TypeError, ValueError):
        logger.debug("pane_geometry_probe_unparseable", value=repr(result))
        return None


async def settle_if_needed(verdict: SettleVerdict) -> None:
    """Pause for :data:`SETTLE_SECONDS` when, and only when, the verdict says so.

    One function so both handshake branches in ``websocket.py`` pay the
    same rule. The issue this closes is explicit that fixing one sleep
    site and leaving the other produces a fast path that is fast on one
    branch only, which is worse than either.

    Args:
        verdict: the answer from :func:`decide_settle`.

    Returns:
        None.

    Example:
        >>> await settle_if_needed(SettleVerdict(False, "x"))
    """
    if verdict.settle:
        await asyncio.sleep(SETTLE_SECONDS)
