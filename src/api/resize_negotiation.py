"""Multi-client terminal size negotiation, wired to the websocket layer.

Extracted from ``src/api/websocket.py``, which is already over the project's
500-line ceiling and must not grow further.

WHAT PROBLEM THIS SOLVES. Two browsers on the same session each send their
own ``pty_resize``. The backend applied them unconditionally, so the last
writer won: the pane ended up sized for one client while the other rendered
its xterm at a different grid and showed garbage. No tmux client is ever
attached here (output is streamed via ``pipe-pane``), so tmux's own
``window-size smallest/largest/latest`` and ``aggressive-resize`` cannot
arbitrate between browsers - they only arbitrate among ATTACHED tmux
clients, of which there are none. The negotiation therefore has to live in
our code. ``window-size manual`` stays set in the backend, because that is
what makes ``resize-window`` authoritative at all.

The rule is smallest-wins; see ``src.core.terminal_size`` for why.
"""

from __future__ import annotations

import json
from typing import Any, Hashable, Optional, Tuple

import structlog

from src.api.attach_settle import NO_RESIZE_ATTEMPTED, ResizeOutcome
from src.core.terminal_size import TerminalSizeNegotiator
from src.models import WSMessageType

logger = structlog.get_logger()


def get_negotiator(session_manager: Any) -> TerminalSizeNegotiator:
    """Return the multi-client terminal size negotiator for this manager.

    Lazily creates and caches ONE negotiator per ``session_manager``
    instance (stashed as a private attribute) rather than using a
    module-level singleton. In production ``session_manager`` is the single
    app.state instance, so this behaves like a singleton and all
    connections negotiate against the same tracked state. In tests that
    build a fresh stand-in manager per test, each test gets its own
    negotiator for free with no teardown.

    Args:
        session_manager: the app's SessionManager, or a duck-typed stand-in
            that supports plain attribute assignment.

    Returns:
        TerminalSizeNegotiator: bound to this session_manager.
    """
    negotiator = getattr(session_manager, "_terminal_size_negotiator", None)
    if negotiator is None:
        negotiator = TerminalSizeNegotiator()
        try:
            session_manager._terminal_size_negotiator = negotiator
        except (AttributeError, TypeError):
            # Some duck-typed stand-ins (frozen namespaces, slotted
            # objects) reject attribute assignment. Fall back to a fresh
            # negotiator per call: no cross-client negotiation, but never a
            # crash. Real SessionManager instances always accept it.
            logger.debug("negotiator_cache_unavailable")
    return negotiator


async def apply_effective_size(
    session_manager: Any,
    session_id: str,
    negotiator: TerminalSizeNegotiator,
    effective: Optional[Tuple[int, int]],
    connection_manager: Any,
    known_pane_size: Optional[Tuple[int, int]] = None,
) -> Tuple[bool, bool]:
    """Resize the backend to a negotiated size and tell shared clients.

    Shared tail of both the "client resized" and "client disconnected"
    paths. Applies ``effective`` to the backend (skipped when None, meaning
    the negotiator determined nothing changed), then, when more than one
    client is attached, broadcasts a ``terminal_size`` control message so
    each client can tell it may be letterboxed for another client's
    benefit. The UI must never silently show a pane sized for someone else.

    ``known_pane_size`` IS A MEASUREMENT OR IT IS NOTHING. When the caller
    has POSITIVELY read the pane's own ``#{pane_width}``/``#{pane_height}``
    and it already equals ``effective``, the backend resize is skipped:
    ``resize-window`` to a size tmux is already at changes nothing, raises
    no ``SIGWINCH``, and costs two blocking subprocess calls on the event
    loop (measured p50 22.81 ms). Pass None - the default, and what every
    caller outside the attach handshake passes - and the resize is issued
    exactly as it always was. A cached or assumed value must never be
    passed here; see :mod:`src.api.attach_settle`.

    Args:
        session_manager: the app's SessionManager (resize_terminal target).
        session_id: session to resize; caller has confirmed it is truthy.
        negotiator: the session's negotiator, for client_count.
        effective: new (cols, rows) to apply, or None to skip.
        connection_manager: object exposing ``broadcast_to_session``.
        known_pane_size: (cols, rows) the PANE itself reported, or None
            when nothing was measured.

    Returns:
        tuple[bool, bool]: ``(issued, failed)``. ``issued`` is True only
        when a backend resize was actually made; ``failed`` is True when
        that call raised. Both False means nothing needed doing.

    Example:
        >>> await apply_effective_size(sm, "s", neg, (80, 24), cm, (80, 24))
        (False, False)
    """
    if effective is None:
        return (False, False)
    eff_cols, eff_rows = effective
    issued = False
    failed = False
    if known_pane_size is not None and tuple(known_pane_size) == (eff_cols, eff_rows):
        logger.debug(
            "negotiated_resize_skipped_pane_already_sized",
            session_id=session_id,
            cols=eff_cols,
            rows=eff_rows,
        )
    else:
        issued = True
        try:
            session_manager.resize_terminal(eff_cols, eff_rows, session_id=session_id)
        except Exception as exc:
            failed = True
            logger.error("negotiated_resize_failed", error=str(exc))

    client_count = negotiator.client_count(session_id)
    if client_count > 1:
        message = json.dumps({
            "type": WSMessageType.TERMINAL_SIZE,
            "cols": eff_cols,
            "rows": eff_rows,
            "clients": client_count,
            "constrained": True,
        })
        await connection_manager.broadcast_to_session(session_id, message)
    return (issued, failed)


async def apply_negotiated_resize(
    session_manager: Any,
    session_id: Optional[str],
    client_key: Hashable,
    cols: int,
    rows: int,
    connection_manager: Any,
    known_pane_size: Optional[Tuple[int, int]] = None,
) -> ResizeOutcome:
    """Record a client's requested size and apply the negotiated result.

    THE TARGET IS THE SESSION'S EFFECTIVE SIZE, NOT THIS CLIENT'S REQUEST.
    With a second browser attached the pane is letterboxed to the
    element-wise minimum, so the geometry the pane is supposed to be at is
    what the negotiator computes across every tracked client. Reporting
    this client's own request would make the attach handshake compare the
    pane against a size it is deliberately not at, and settle forever.

    Args:
        session_manager: the app's SessionManager (resize_terminal target).
        session_id: session the client is attached to. Falsy is a no-op:
            there is nothing to negotiate for an unresolved session.
        client_key: hashable identifying this connection (the websocket).
        cols: this client's requested width in columns.
        rows: this client's requested height in rows.
        connection_manager: object exposing ``broadcast_to_session``.
        known_pane_size: (cols, rows) the pane itself reported, or None.
            See :func:`apply_effective_size`; a measurement or nothing.

    Returns:
        ResizeOutcome: the negotiated target plus whether a backend
        resize was actually issued and whether it failed. Callers that
        do not need it may ignore it; the attach handshake keys its
        settle on it.

    Example:
        >>> await apply_negotiated_resize(sm, "s", ws, 80, 24, cm, (80, 24))
        ResizeOutcome(target=(80, 24), issued=False, failed=False)
    """
    if not session_id:
        return NO_RESIZE_ATTEMPTED
    negotiator = get_negotiator(session_manager)
    effective = negotiator.set_client_size(session_id, client_key, cols, rows)
    issued, failed = await apply_effective_size(
        session_manager, session_id, negotiator, effective, connection_manager,
        known_pane_size=known_pane_size,
    )
    return ResizeOutcome(
        target=negotiator.effective_size(session_id),
        issued=issued,
        failed=failed,
    )


async def release_client_resize(
    session_manager: Any,
    session_id: Optional[str],
    client_key: Hashable,
    connection_manager: Any,
) -> None:
    """Drop a disconnecting client from negotiation and re-apply the size.

    If the departing client was the one constraining the session, the
    effective size GROWS BACK for whoever remains. Without this a session
    would stay letterboxed forever after the small client left, which is
    the obvious way a smallest-wins scheme goes wrong.

    Args:
        session_manager: the app's SessionManager (resize_terminal target).
        session_id: session the client was attached to. Falsy is a no-op.
        client_key: the same key passed to ``apply_negotiated_resize``.
        connection_manager: object exposing ``broadcast_to_session``.

    Returns:
        None. Side effects only.
    """
    if not session_id:
        return
    negotiator = get_negotiator(session_manager)
    effective = negotiator.remove_client(session_id, client_key)
    await apply_effective_size(
        session_manager, session_id, negotiator, effective, connection_manager
    )
