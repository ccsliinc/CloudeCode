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

So this module answers only the POSITIVE half, and the caller keeps its
existing probe for everything else:

    exists = listing_proves_alive(status_map, name) or backend.is_alive()

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

    def __init__(
        self, rows: Optional[Dict[str, Any]] = None, *, complete: bool = False
    ) -> None:
        """Build the map.

        Inputs:
            rows: ``{tmux_session_name: row}``; empty when the listing
                found nothing or could not run.
            complete: True iff the listing ran and its enumeration of
                live session names can be trusted.
        Output: None.
        Example:
            >>> StatusMap({"cloude_a": {"status": "running"}}, complete=True)
            {'cloude_a': {'status': 'running'}}
        """
        super().__init__(rows or {})
        self.complete = bool(complete)


def listing_proves_alive(
    status_map: Optional[Dict[str, Any]], tmux_name: Optional[str]
) -> bool:
    """Does the bulk listing POSITIVELY show this session exists?

    Description: the one place that decides whether the bulk row may
        stand in for a ``tmux has-session`` call, and it answers only the
        half the listing can prove. True means the completed listing
        named this session, so no probe is needed. False means ONLY "this
        listing does not establish it" - never "it is gone" - and the
        caller must fall back to its own probe. See the module docstring
        for why the negative is deliberately not trusted.
    Inputs:
        status_map: the map from ``_build_tmux_status_map``. A
            :class:`StatusMap` carries its own completeness; any other
            mapping (a test double, a legacy caller) is treated as not
            stating it and can never prove anything.
        tmux_name: the tmux session name to look for, or None. A session
            with no tmux name cannot be looked up by name - the
            PTYBackend case, which appears in no tmux listing at all - so
            it is never proven here.
    Output:
        bool - True when the listing names it and may be trusted;
        False when the caller must probe.
    Example:
        >>> m = StatusMap({"cloude_a": {}}, complete=True)
        >>> listing_proves_alive(m, "cloude_a")
        True
        >>> listing_proves_alive(m, "cloude_b")
        False
        >>> listing_proves_alive({"cloude_a": {}}, "cloude_a")
        False
    """
    if not tmux_name:
        return False
    if status_map is None:
        return False
    if not getattr(status_map, "complete", False):
        return False
    return tmux_name in status_map
