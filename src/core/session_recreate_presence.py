"""Is a tmux SESSION still on the socket? The gate a recreate rests on.

Its own module, next door to ``session_recreate.py``, for the reason
``session_startup_gate_ledger`` sits next to ``session_startup_gate``:
this is the MEASUREMENT and that is the DECISION, and the measurement is
the half that has to be provable with no tmux server in the room.

WHY ``TmuxBackend.is_alive`` IS NOT THE ANSWER. It runs ``has-session``
and returns a bool, so "tmux says no such session" (rc 1) and "tmux is
missing, timed out, or the server errored" (also non-zero) come back as
the same False. A recreate built on that would spawn a second tmux
session beside a perfectly healthy one over a socket hiccup, and then
rebind the row onto the newcomer - leaving the pane the user is actually
talking to alive, unreferenced and invisible. Every gate in this project
that guards something irreversible keeps could-not-look apart from
measured-absent, and this is no exception.

SO THE MEASUREMENT IS A LISTING. ``TmuxBackend.discover_existing()``
already carries the discipline in two fields: ``TmuxListing.ok`` says the
probe RAN, and ``TmuxListing.complete`` says the rows it returned are the
WHOLE answer rather than merely a valid one. Both are required, because a
row the parser refused is a session name nobody read, and it may be the
one being asked about.

THE NAMESPACE IS PART OF THE MEASUREMENT, not a detail of it.
``discover_existing`` filters its answer to ``SESSION_PREFIX``, so a
session named outside that namespace is absent from the listing whether
or not it is running. Reading that absence as a verdict would be reading
the FILTER rather than the socket, so a non-prefixed name answers
:data:`TMUX_UNKNOWN`. That also happens to be the right answer on its own
terms for an adopted external session: this app did not launch it and
holds no record of what to put back.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

from src.core.session_respawn import PANE_ALIVE, PANE_DEAD, PANE_UNKNOWN

#: MEASURED ABSENCE. A complete listing ran and this name is not on the
#: socket. The ONLY presence outcome a recreate may act on.
TMUX_GONE: str = "gone"

#: MEASURED PRESENCE. The name is on the socket, so the ordinary restart
#: path owns this session and a recreate must not touch it.
TMUX_PRESENT: str = "present"

#: COULD NOT EVALUATE. The listing did not run, was incomplete, or cannot
#: see names of this shape. Never rendered as :data:`TMUX_GONE`.
TMUX_UNKNOWN: str = "unknown"

#: Every value :func:`tmux_presence` can return.
ALL_TMUX_PRESENCE: frozenset[str] = frozenset(
    {TMUX_GONE, TMUX_PRESENT, TMUX_UNKNOWN}
)


@dataclass(frozen=True)
class TmuxPresence:
    """Whether one tmux session name is still on the socket.

    Attributes:
        outcome: one of the three ``TMUX_*`` constants.
        detail: a plain sentence, fit to show verbatim.
        listed: how many names the listing carried, for the log line. Not
            evidence on its own - a listing of zero is a real answer only
            when ``outcome`` already says so.
    """

    outcome: str
    detail: str = ""
    listed: int = 0

    @property
    def gone(self) -> bool:
        """True only on a MEASURED absence.

        Description: the one test a recreate may be built on.
          :data:`TMUX_UNKNOWN` is deliberately False - not having been
          able to look is not evidence of absence.
        Inputs: n/a. Output: bool.
        Example: tmux_presence('cloude_a', listing_ok=True,
          listing_complete=True, names=[]).gone  # True
        """
        return self.outcome == TMUX_GONE


def tmux_presence(
    name: Optional[str],
    *,
    listing_ok: bool,
    listing_complete: bool,
    names: Optional[Sequence[str]],
    namespace_prefix: str = "cloude_",
) -> TmuxPresence:
    """Classify one tmux session name against a socket listing. PURE.

    Description: the gate, and the whole of it. The caller runs
      ``TmuxBackend.discover_existing()`` and hands over the three facts
      that listing reports; this decides. Purity is what lets the
      ``present``, ``incomplete`` and ``unknown`` branches be exercised
      without a tmux server - which is exactly where an untested branch
      would otherwise hide, since a working box only ever produces one of
      them.

      PRESENCE IS TESTED BEFORE COMPLETENESS, on purpose. Finding the
      name is positive evidence whatever else the listing dropped; not
      finding it is only evidence when nothing was dropped.
    Inputs: name (str | None) - the literal tmux session name.
      listing_ok (bool) - ``TmuxListing.ok``. listing_complete (bool) -
      ``TmuxListing.complete``. names (Sequence[str] | None) - the names
      the listing carried. namespace_prefix (str) - the namespace the
      listing is filtered to; a name outside it is UNKNOWN, never gone.
    Output: TmuxPresence.
    Example: tmux_presence('cloude_a', listing_ok=True,
      listing_complete=True, names=['cloude_b']).outcome  # 'gone'
    """
    target = (name or "").strip()
    if not target:
        return TmuxPresence(
            outcome=TMUX_UNKNOWN,
            detail=(
                "no tmux session name was given, so whether it is still "
                "running was not evaluated"
            ),
        )
    if not listing_ok:
        return TmuxPresence(
            outcome=TMUX_UNKNOWN,
            detail=(
                "the tmux socket could not be listed, so whether this "
                "session is still running was not evaluated"
            ),
        )
    rows = [str(n).strip() for n in (names or [])]
    if target in rows:
        return TmuxPresence(
            outcome=TMUX_PRESENT,
            detail=(
                f"the tmux session {target!r} is still on the socket, so "
                "it restarts in place rather than being recreated"
            ),
            listed=len(rows),
        )
    if not listing_complete:
        # VALID BUT NOT WHOLE. A row the parser refused is a name nobody
        # read, and absence from a partial list is not absence.
        return TmuxPresence(
            outcome=TMUX_UNKNOWN,
            detail=(
                "the tmux listing was incomplete, so this session's "
                "absence from it is not evidence that it is gone"
            ),
            listed=len(rows),
        )
    if namespace_prefix and not target.startswith(namespace_prefix):
        # READING THE FILTER, NOT THE SOCKET.
        return TmuxPresence(
            outcome=TMUX_UNKNOWN,
            detail=(
                f"the tmux session {target!r} is outside this app's "
                f"{namespace_prefix!r} namespace, which the listing does "
                "not cover, so its absence was not measured"
            ),
            listed=len(rows),
        )
    return TmuxPresence(
        outcome=TMUX_GONE,
        detail=(
            f"the tmux session {target!r} is not on the socket, so there "
            "is no pane to restart and this session can only come back "
            "as a new one"
        ),
        listed=len(rows),
    )


def pane_state_for(presence: TmuxPresence) -> str:
    """Render a presence verdict in the preview's ``pane_state`` vocabulary.

    Description: the preview model has carried ``dead`` / ``alive`` /
      ``unknown`` since the restart picker shipped, so a recreate preview
      reuses those three words rather than teaching the client a fourth.
      A session that is GONE has no pane at all, which the picker already
      renders as the restartable case; ``unknown`` stays honestly
      unknown, and the picker leaves its button disabled for it.
    Inputs: presence (TmuxPresence).
    Output: str - one of ``PANE_DEAD`` / ``PANE_ALIVE`` / ``PANE_UNKNOWN``.
    Example: pane_state_for(TmuxPresence(TMUX_GONE))  # 'dead'
    """
    if presence.outcome == TMUX_GONE:
        return PANE_DEAD
    if presence.outcome == TMUX_PRESENT:
        return PANE_ALIVE
    return PANE_UNKNOWN
