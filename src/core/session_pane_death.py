"""Is this session's PANE measured dead? The gate the husk reaper rests on.

WHY THIS FILE EXISTS. ``session_lifecycle`` reaps on ABSENCE: a stored
``running`` row whose ``(tmux_name, tmux_created_epoch)`` is missing from
a complete listing is moved to ``stopped``, and that is the only thing
that ever puts a row into RECENT. But this app sets ``remain-on-exit on``,
precisely so a pane whose process exits leaves its final screen behind to
be read. tmux keeps that session LISTED. So the one case the owner's
ruling is about - "a dead pane drops off the live list and belongs in
recent" - is the exact case the absence reaper can never see.

MEASURED ON THE OWNER'S BOX, 2026-09-10. ``cloude_cloudecode`` carried
``pane_dead=1``; its pane had died that morning. The row still read
``lifecycle='running'`` hours later, because the husk was still in the
listing. The corpse squatted its own name, so the next session for that
project was forced to become ``cloude_cloudecode-2``
(``session_create_name_uniquified``), and the row sat in neither group the
user can see: gone from the live list, never arriving in RECENT. That is a
CORRECTNESS gap and not a performance one - a dead pane costs no extra
work per listing pass today, and this change must not be justified on cost.

THE GATE, AND THE ASYMMETRY IN IT, WHICH IS THE WHOLE DESIGN.

A reap is DURABLE and USER-VISIBLE. A wrong one takes a session the user
is working in out of their running list, and afterwards it is
indistinguishable from a measurement. So this answers :data:`PANE_DEAD`
ONLY on a positively measured ``#{pane_dead}`` of ``"1"``, read out of a
COMPLETE pane listing taken from the SOCKET THE BACKEND IS BOUND TO, for a
row whose creation epoch matches the one the stored session claims.
EVERYTHING else is :data:`PANE_UNKNOWN` and reaps nothing: no listing at
all, an incomplete one, an unstated or mismatched socket, a name the
listing does not carry, a row that is not a readable mapping, an epoch
that is absent or unreadable or belongs to a different instance, and a
``pane_dead`` field that is missing or is any text other than ``"0"`` or
``"1"``.

REFUSING IS FREE AND REAPING WRONGLY IS NOT. Every refusal above leaves
the row exactly as it was, which is the behaviour that shipped before this
module existed - so an over-eager refusal costs nothing at all, while one
over-eager reap costs a live session. That is the same trade
``listing_proves_alive`` makes for the positive half of the same listing,
and the same one ``session_recreate_presence`` makes for ``gone``.

THE EPOCH IS NOT OPTIONAL, AND IT IS THE HALF THAT IS EASY TO DROP. The
pane listing is keyed by tmux NAME, and a name is not an identity in this
app - it is minted from a project slug and re-minted every time a session
is recreated. Match on the name alone and a brand new ``cloude_work``,
alive and being typed into, inherits the verdict measured on the corpse
that held that name a minute ago. ``list_pane_status_all`` already carries
``#{session_created}`` for exactly this reason, so the check costs nothing
but a comparison and is required rather than advisory: a row that cannot
supply a readable epoch answers :data:`PANE_UNKNOWN`.

NO NEW SUBPROCESS, BY CONSTRUCTION. Nothing here shells out. The caller
hands in a listing that the launcher's pass was already paying for
(``TmuxBackend.list_pane_status_all``, one ``tmux list-panes -a``, whose
format string has carried ``#{pane_dead}`` since it shipped), so this rung
adds no tmux call of its own. If a future change finds itself probing tmux
to answer this question, the answer belongs in that existing listing
instead.

WHAT IT DOES NOT DECIDE. Whether a dead pane's tmux HUSK should be killed
to free its name. That is a separate, destructive act needing its own
authorization, and ``remain-on-exit`` exists to preserve exactly what
killing it would destroy. This module measures; it does not clean up.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional

from src.core.session_respawn import PANE_ALIVE, PANE_DEAD, PANE_UNKNOWN

#: The raw ``#{pane_dead}`` text tmux prints for a pane whose process has
#: exited. Compared EXACTLY (after a strip) rather than truthily, so that
#: an empty field, a ``-`` from a format tmux did not understand, or any
#: future spelling lands on PANE_UNKNOWN instead of quietly reading dead.
PANE_DEAD_TRUE: str = "1"

#: The raw ``#{pane_dead}`` text for a pane that still has a process.
PANE_DEAD_FALSE: str = "0"

#: The ``sessions.lifecycle_source`` this rung writes. Deliberately
#: DISTINCT from ``tmux_missing`` (absent from a listing) and from
#: ``closed_by_user`` (we killed it): this one means "tmux still lists the
#: session and reports its pane dead", which is a different measurement and
#: worth being able to tell apart in the row afterwards.
LIFECYCLE_SOURCE_PANE_DEAD: str = "pane_dead"


@dataclass(frozen=True)
class PaneDeath:
    """Whether one stored instance's pane was measured dead.

    Attributes:
        outcome: one of :data:`PANE_DEAD`, :data:`PANE_ALIVE` or
            :data:`PANE_UNKNOWN`, re-used from ``session_respawn`` rather
            than minted here so the app has one pane-state vocabulary.
        detail: a plain sentence naming which rung answered, fit for a log
            line. Never parsed.
        pane_dead_raw: the raw ``#{pane_dead}`` text that was read, or None
            when no field was reached. Carried so an audit can see the
            evidence rather than only the verdict.
    """

    outcome: str
    detail: str = ""
    pane_dead_raw: Optional[str] = None

    @property
    def dead(self) -> bool:
        """True ONLY on a positively measured dead pane.

        Description: the one test a reap may be built on.
          :data:`PANE_UNKNOWN` is deliberately False - not having been
          able to look is not evidence the process exited - and so is
          :data:`PANE_ALIVE`, obviously.
        Inputs: none.
        Output: bool.
        Example:
            >>> PaneDeath(PANE_UNKNOWN).dead
            False
        """
        return self.outcome == PANE_DEAD


def _unknown(detail: str, raw: Optional[str] = None) -> PaneDeath:
    """Build the COULD NOT EVALUATE result, the only shape a refusal has.

    Description: a named constructor so the nine refusal rungs cannot
      accidentally differ from one another, and so none of them can grow
      a field that would read as a measurement.
    Inputs: detail (str) - why we could not answer. raw (str | None) - the
      ``#{pane_dead}`` text, when one was actually reached.
    Output: PaneDeath with ``outcome=PANE_UNKNOWN``.
    Example: _unknown('no pane listing was supplied')
    """
    return PaneDeath(outcome=PANE_UNKNOWN, detail=detail, pane_dead_raw=raw)


def pane_death(
    pane_status: Optional[Mapping[str, Any]],
    tmux_name: Optional[str],
    created_epoch: Optional[int],
    *,
    backend_socket: Optional[str] = None,
) -> PaneDeath:
    """Measure one stored instance's pane against a bulk pane listing.

    Description: the whole rule, with no I/O, so every refusal is
      reachable in a test with no tmux server in the room. The ladder is
      ordered cheapest-refusal-first and only its last rung can answer
      :data:`PANE_DEAD`. See the module docstring for why each refusal is
      a refusal rather than a default.
    Inputs:
        pane_status: the bulk ``list-panes -a`` result indexed by tmux
            session name, normally a
            :class:`~src.core.session_status_map.StatusMap` so that it
            carries its own ``complete`` and its own ``socket``. Any other
            mapping (a legacy caller, a plain-dict test double) states
            neither and can therefore prove nothing, which is the same
            degradation ``listing_proves_alive`` applies. None means no
            listing was taken at all.
        tmux_name: the stored row's tmux session name.
        created_epoch: the stored row's ``tmux_created_epoch``, the second
            half of the instance identity. Required: a name alone is not
            an identity in this app.
        backend_socket: the socket the ASKING caller is reconciling. None
            means the caller did not state it, and an unstated socket is
            refused rather than assumed to match, because a session name
            is not unique across sockets.
    Output:
        PaneDeath - read ``.dead`` before anything else.
    Example:
        >>> from src.core.session_status_map import StatusMap
        >>> m = StatusMap(
        ...     {"cloude_a": {"pane_dead": "1", "created_at_epoch": 7}},
        ...     complete=True,
        ...     socket="cloude",
        ... )
        >>> pane_death(m, "cloude_a", 7, backend_socket="cloude").dead
        True
        >>> pane_death(m, "cloude_a", 8, backend_socket="cloude").outcome
        'unknown'
        >>> pane_death(m, "cloude_a", 7, backend_socket="other").outcome
        'unknown'
    """
    if pane_status is None:
        return _unknown("no pane listing was taken on this pass")
    if not getattr(pane_status, "complete", False):
        # Either the probe did not run, or the mapping does not state
        # completeness at all. Both are "we did not get a whole answer",
        # and an absence-or-value argument needs a whole one.
        return _unknown("the pane listing is not a complete enumeration")
    listing_socket = getattr(pane_status, "socket", None)
    if not listing_socket or not backend_socket:
        return _unknown("the pane listing or the caller did not state a socket")
    if listing_socket != backend_socket:
        return _unknown(
            f"the pane listing came from socket {listing_socket!r}, "
            f"not from {backend_socket!r}"
        )
    if not tmux_name:
        return _unknown("the stored row carries no tmux name")
    if isinstance(created_epoch, bool) or not isinstance(created_epoch, int):
        return _unknown("the stored row carries no readable creation epoch")
    row = pane_status.get(tmux_name)
    if row is None:
        # ABSENCE PROVES NOTHING HERE. A name the pane listing does not
        # carry may be a session on another socket, a row the parser
        # refused, or a pane that arrived between the two probes. The
        # absence reaper owns the absence argument and owns it against a
        # listing built for that purpose.
        return _unknown("the pane listing does not carry this session name")
    if not isinstance(row, dict):
        # ``dict`` rather than ``Mapping`` for the same reason
        # ``live_instance_keys`` uses it: every producer of these rows
        # builds plain dicts, and an isinstance against an abstract base
        # is a wider door than this gate wants.
        return _unknown("the pane listing row is not a readable mapping")
    row_epoch = row.get("created_at_epoch")
    if isinstance(row_epoch, bool) or not isinstance(row_epoch, int):
        return _unknown("the pane listing row carries no readable creation epoch")
    if int(row_epoch) != int(created_epoch):
        # The name has been re-minted. This row describes somebody else,
        # and reading it would apply a corpse's verdict to a live session.
        return _unknown(
            f"the pane listing row is instance {int(row_epoch)}, "
            f"not {int(created_epoch)}"
        )
    raw = row.get("pane_dead")
    if not isinstance(raw, str):
        return _unknown("the pane listing row carries no pane_dead field")
    value = raw.strip()
    if value == PANE_DEAD_TRUE:
        return PaneDeath(
            outcome=PANE_DEAD,
            detail="tmux reports this instance's pane dead",
            pane_dead_raw=value,
        )
    if value == PANE_DEAD_FALSE:
        return PaneDeath(
            outcome=PANE_ALIVE,
            detail="tmux reports this instance's pane running",
            pane_dead_raw=value,
        )
    # ANY OTHER TEXT IS UNREADABLE, NOT ALIVE AND CERTAINLY NOT DEAD.
    # ``pane_state_from_probe`` reads everything-but-"1" as alive, which is
    # the safe default where it is used (a respawn refuses a live pane).
    # Here the safe default is the third outcome, because "alive" is itself
    # a claim and this function's callers may one day act on it.
    return _unknown(f"pane_dead was {raw!r}, which is neither '0' nor '1'", raw)
