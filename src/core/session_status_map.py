"""The bulk pane listing, and when it may stand in for a liveness probe.

WHY THIS FILE EXISTS. ``SessionManager._build_tmux_status_map`` runs ONE
``tmux list-panes -a`` covering every session on the socket, and that one
listing already enumerates, by name, every session tmux currently holds.
``_session_info_for`` nevertheless asked tmux again, once per session, via
``backend.is_alive()`` (``tmux has-session``) - a second subprocess per row
answering a question the bulk row had already answered.

MEASURED ON THE OWNER'S BOX, 2026-09-09, 13 live sessions: one listing
pass cost 27 tmux subprocesses and 1008 ms, of which 377 ms was those
per-session ``has-session`` calls. The whole pass runs synchronously
inside ``async def list_session_infos``, so for the duration of it the
server's event loop does nothing else at all - it cannot read the tmux
pipe that carries terminal output, cannot spawn the ``send-keys`` that
delivers a keystroke, and cannot answer any other request. That is why a
redundant subprocess in a LISTING shows up to the user as lag in the
TERMINAL.

THE EVIDENCE IS ASYMMETRIC, AND THAT ASYMMETRY IS THE WHOLE DESIGN.
A completed listing that NAMES a session proves that session exists: tmux
was asked to enumerate its panes and it produced this one. A listing that
does NOT name it proves much less. The listing is one moment in time, it
covers only the socket the PROBE was bound to, and a caller may hold a
backend pinned to a different socket - so an absent name is "not shown to
be alive", not "shown to be dead". Dropping a row on that would delete a
live session from the sidebar on the strength of a negative.

AND THE POSITIVE HALF IS ONLY EVIDENCE ABOUT THE SOCKET IT WAS TAKEN
FROM. The probe that produced this listing was bound to ONE tmux socket,
while ``backend.is_alive()`` - the call being replaced - runs
``tmux has-session`` on THAT BACKEND'S OWN socket. Those are the same
socket in this process today and nothing enforces it. A tmux session name
is not unique across sockets, this app mints names from project slugs, and
a user's personal ``tmux`` server can hold a ``cloude_Foo`` of its own. So
a name found on the PROBE'S socket would vouch for a session held by a
backend pinned somewhere else, and a dead session would paint alive - the
false green this codebase keeps paying for. The socket the listing came
from therefore travels ON the map, and a caller must state the socket it
is asking ABOUT; if either is unstated, or they differ, this refuses and
the caller pays the probe it was always paying. A refusal costs exactly
the pre-fix behaviour, so refusing too often is free and answering wrongly
is not.

So this module answers only the POSITIVE half, and the caller keeps its
existing probe for everything else:

    exists = (
        listing_proves_alive(
            status_map, name, backend_socket=backend.socket_name
        )
        or backend.is_alive()
    )

That is the same shape this codebase already uses for the startup gate's
tail (rung 5 refuses, rung 7 answers) and for transcript presence: not
having looked is not evidence of absence, but having looked and found
something IS evidence of presence. It also costs nothing in practice,
because in steady state every registered session IS in the listing - all
13 on the owner's box - so the probe is reached only for the handful of
rows that are about to be dropped anyway.

WHY A ``dict`` SUBCLASS RATHER THAN A TUPLE OR A NEW RETURN TYPE. Every
existing consumer does ``status_map.get(name)`` and several tests
monkeypatch ``_build_tmux_status_map`` to return a plain ``dict``. A dict
subclass keeps all of them working untouched, and a plain-dict double
simply has no ``complete`` attribute - which :func:`listing_proves_alive`
reads as "cannot vouch", falling back to the old per-session probe. A
test double that does not state completeness therefore gets the OLD
behaviour rather than a silently different one.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class StatusMap(dict):
    """``{tmux_session_name: pane row}`` plus whether the listing is whole.

    ``complete`` is True only when the bulk ``list-panes -a`` probe ran
    and returned a real answer - INCLUDING a real answer of zero sessions
    (``reason='no_server'``), which is a measurement and not a failure.
    It is False when the probe could not run, in which case the listing
    cannot vouch for anything at all.
    """

    #: Class-level default so an instance built without the flag - and any
    #: code path that reads it off a plain dict via ``getattr`` - reads as
    #: "not stated" rather than raising.
    complete: bool = False

    #: The tmux socket this listing was taken from, or None for "not
    #: stated". Same default discipline as ``complete``: a map that does
    #: not say which socket it describes can vouch for nothing, because a
    #: session NAME is not unique across sockets.
    socket: Optional[str] = None

    def __init__(
        self,
        rows: Optional[Dict[str, Any]] = None,
        *,
        complete: bool = False,
        socket: Optional[str] = None,
    ) -> None:
        """Build the map.

        Inputs:
            rows: ``{tmux_session_name: row}``; empty when the listing
                found nothing or could not run.
            complete: True iff the listing ran and its enumeration of
                live session names can be trusted.
            socket: the tmux socket the listing was taken from. None
                means "not stated", which makes the map unable to prove
                anything about any backend.
        Output: None.
        Example:
            >>> StatusMap(
            ...     {"cloude_a": {"status": "running"}},
            ...     complete=True,
            ...     socket="cloude",
            ... )
            {'cloude_a': {'status': 'running'}}
        """
        super().__init__(rows or {})
        self.complete = bool(complete)
        self.socket = socket or None


def listing_proves_alive(
    status_map: Optional[Dict[str, Any]],
    tmux_name: Optional[str],
    *,
    backend_socket: Optional[str] = None,
) -> bool:
    """Does the bulk listing POSITIVELY show this session exists?

    Description: the one place that decides whether the bulk row may
        stand in for a ``tmux has-session`` call, and it answers only the
        half the listing can prove. True means the completed listing was
        taken from THIS BACKEND'S SOCKET and named this session, so no
        probe is needed. False means ONLY "this listing does not
        establish it" - never "it is gone" - and the caller must fall
        back to its own probe. See the module docstring for why neither
        the negative nor a cross-socket positive is trusted.
    Inputs:
        status_map: the map from ``_build_tmux_status_map``. A
            :class:`StatusMap` carries its own completeness and its own
            socket; any other mapping (a test double, a legacy caller) is
            treated as stating neither and can never prove anything.
        tmux_name: the tmux session name to look for, or None. A session
            with no tmux name cannot be looked up by name - the
            PTYBackend case, which appears in no tmux listing at all - so
            it is never proven here.
        backend_socket: the socket the ASKING backend is pinned to, which
            is the socket its own ``is_alive()`` would have probed.
            Required in practice: None means the caller did not state it,
            and an unstated socket is refused rather than assumed to
            match. A name is not unique across sockets, so answering on a
            mismatch would vouch for a different tmux session that merely
            shares a name.
    Output:
        bool - True when the listing is complete, was taken from this
        backend's socket, and names it; False when the caller must probe.
    Example:
        >>> m = StatusMap({"cloude_a": {}}, complete=True, socket="cloude")
        >>> listing_proves_alive(m, "cloude_a", backend_socket="cloude")
        True
        >>> listing_proves_alive(m, "cloude_b", backend_socket="cloude")
        False
        >>> listing_proves_alive(m, "cloude_a", backend_socket="default")
        False
        >>> listing_proves_alive(m, "cloude_a")
        False
        >>> listing_proves_alive({"cloude_a": {}}, "cloude_a",
        ...                      backend_socket="cloude")
        False
    """
    if not tmux_name:
        return False
    if status_map is None:
        return False
    if not getattr(status_map, "complete", False):
        return False
    listing_socket = getattr(status_map, "socket", None)
    if not listing_socket or not backend_socket:
        return False
    if listing_socket != backend_socket:
        return False
    return tmux_name in status_map


def status_map_from_listing(
    listing: Any, *, socket: Optional[str]
) -> "StatusMap":
    """Index one ``list-panes -a`` result by session name, with provenance.

    Description: the single place a pane listing becomes a
      :class:`StatusMap`, so the two facts that make the map usable as
      EVIDENCE - whether the enumeration is whole, and which socket it
      came from - are attached by one rule rather than restated at every
      construction site. A listing that did not answer yields an EMPTY map
      stating neither, which every consumer already reads as "cannot
      vouch" and falls back from.
    Inputs:
        listing: a ``TmuxListing`` from ``list_pane_status_all``. Typed
            loosely on purpose so this module keeps no import edge to
            ``tmux_listing``; only ``.ok``, ``.complete`` and ``.sessions``
            are read.
        socket: the socket the probe that produced the listing was
            ACTUALLY bound to, read off the probe rather than re-derived
            from settings, so the map can never claim a socket the listing
            did not come from. None means "not stated", which makes the
            map unable to prove anything.
    Output:
        StatusMap - rows keyed by tmux session name.
    Example:
        >>> class L:
        ...     ok = True
        ...     complete = True
        ...     sessions = [{"name": "cloude_a", "pane_dead": "0"}]
        >>> status_map_from_listing(L(), socket="cloude").complete
        True
    """
    if not getattr(listing, "ok", False):
        return StatusMap()
    return StatusMap(
        {
            row["name"]: row
            for row in getattr(listing, "sessions", None) or []
            if isinstance(row, dict) and row.get("name")
        },
        complete=bool(getattr(listing, "complete", False)),
        socket=socket,
    )
