"""The outcome of the most recent tmux listing probe, and who owns it.

Slice S1 of the ``session_manager`` decomposition. This module holds the
``ProbeHealth`` value and the ``ProbeHealthRecorder`` that owns it, which
between them replace four loose scalars that used to sit on
``SessionManager`` (``_last_probe_ok``, ``_last_probe_reason``,
``_last_probe_detail``, ``_last_probe_socket``).

**THREE OUTCOMES, NOT TWO, IS THE WHOLE POINT OF THE CLUSTER.** "No probe
has run yet" is a real answer and must never be read as "probed and
healthy". Every method below is shaped so that the false-green reading is
not expressible rather than merely discouraged: ``record_success`` takes
no arguments at all, so a success cannot carry a stale failure reason,
and the initial state is a ``ProbeHealth(ok=None)`` that only a recorded
probe can replace.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class ProbeHealth:
    """Outcome of the most recent tmux listing probe (S9).

    THREE OUTCOMES, not two. ``ok=None`` ("never probed") must never be
    read the same as ``ok=True`` ("probed and healthy") - a caller that
    treats "no answer yet" as "healthy" is exactly the false-green class
    this repo's CLAUDE.md names as the recurring defect. See
    ``ProbeHealthRecorder.health`` and ``SessionManager.last_probe_health``.

    Attributes:
        ok: None - no probe has run yet this process's lifetime.
            True - the most recent probe succeeded (regardless of how
            many rows it returned). False - the most recent probe
            failed.
        reason: short machine token for the failure (mirrors
            ``TmuxListing.reason``), or None when ``ok`` is not False.
        detail: human-readable detail for the same failure, or None.
    """

    ok: Optional[bool]
    reason: Optional[str] = None
    detail: Optional[str] = None


class ProbeHealthRecorder:
    """Owns the health and the bound socket of the most recent tmux probe.

    Description: the single owner of the probe cluster. ``SessionManager``
      holds one of these and keeps NO copy of the values, so the two can
      never disagree; the facade's ``last_probe_health``,
      ``list_attachable_sessions_with_socket`` and ``_tmux_socket_name``
      all read through it.

    S9 - the health recorded here is the health of the MOST RECENT probe,
      whichever caller ran it (``list_attachable_sessions`` is the common
      path, called on every home-screen poll). ``ok`` is None until the
      first probe of this process's lifetime - genuinely different from
      both True and False, because "never checked" is its own answer and
      must not be read as "checked and healthy". The RECENT group
      (``GET /sessions/recent``) reads this rather than triggering its own
      extra probe: RESTART safety depends on the stored ``stopped`` rows
      being trustworthy RIGHT NOW, and a currently-failing probe means we
      cannot currently confirm that - a row that looks stopped in a stale
      read could in fact be running, and offering RESTART against it is
      how you get two of the same session.

    Example:
        >>> rec = ProbeHealthRecorder()
        >>> rec.health.ok is None  # never probed is its own answer
        True
        >>> rec.record_success()
        >>> rec.health.ok
        True
    """

    def __init__(self) -> None:
        """Start in the never-probed state.

        Description: the initial ``ProbeHealth(ok=None)`` is the honest
          answer for a process that has not yet asked tmux anything.
        Inputs: none.
        Output: None.
        """
        self._health: ProbeHealth = ProbeHealth(ok=None)
        self._socket: Optional[str] = None

    @property
    def health(self) -> ProbeHealth:
        """The outcome of the most recent probe.

        Description: THE ONLY reader of the recorded health. Returns the
          held value rather than rebuilding one, so there is exactly one
          place a probe outcome is composed.
        Inputs: none.
        Output: ProbeHealth - ``ok`` is None when no probe has run yet
          this process's lifetime, True/False otherwise, with
          ``reason``/``detail`` populated only on a known failure.
        Example: recorder.health.ok
        """
        return self._health

    @property
    def socket(self) -> Optional[str]:
        """The tmux socket the most recent probe was ACTUALLY bound to.

        Description: None until the first probe runs. Read off the probe
          backend rather than off settings, because the two can disagree
          (a harness may pin a backend to a dedicated socket) and a row
          keyed on one socket while the listing came from another is the
          exact defect main.py's ``socket=`` argument was added to fix:
          writer and reader agree with each other and neither agrees with
          tmux.
        Inputs: none.
        Output: str | None.
        Example: recorder.socket  # 'cloude'
        """
        return self._socket

    def record_socket(self, socket_name: Optional[str]) -> None:
        """Record which socket the probe backend is bound to.

        Description: called BEFORE the listing is requested, because the
          probe backend is bound at construction and the socket is a fact
          about the backend rather than about the listing's outcome. A
          probe that then FAILS still bound to a socket, and that is
          still the socket its failure describes.
        Inputs: socket_name (str | None) - the backend's ``socket_name``,
          None when the backend does not expose one.
        Output: None.
        Example: recorder.record_socket(getattr(probe, "socket_name", None))
        """
        self._socket = socket_name

    def record_success(self) -> None:
        """Record that the most recent probe succeeded.

        Description: a successful listing is this process's evidence that
          tmux answered just now, independent of what rows it returned -
          an empty tmux server is still a successful probe.
          TAKES NO ARGUMENTS BY DESIGN: a success has no reason and no
          detail, so a signature that cannot accept them cannot record a
          success still carrying the previous failure's text. The rule is
          structural rather than remembered.
        Inputs: none.
        Output: None.
        Example: recorder.record_success()
        """
        self._health = ProbeHealth(ok=True)

    def record_failure(self, *, reason: Optional[str], detail: Optional[str]) -> None:
        """Record that the most recent probe failed, and why.

        Description: propagates the listing's own ``reason``/``detail``
          verbatim so the badge can say what went wrong rather than
          rendering a bare "unavailable". Nothing about the stored
          ``sessions`` table is touched by a failed probe - only this
          in-memory flag moves.
        Inputs: reason (str | None) - short machine token, mirrors
          ``TmuxListing.reason``. detail (str | None) - human-readable
          detail. Keyword-only, so the two cannot be swapped at a call
          site.
        Output: None.
        Example: recorder.record_failure(reason="timeout", detail="tmux busy")
        """
        self._health = ProbeHealth(ok=False, reason=reason, detail=detail)

    def socket_name(self, configured: str) -> str:
        """The socket to key rows on: the probed one, else the configured one.

        Description: THE PROBE WINS OVER SETTINGS WHEN THE TWO DISAGREE,
          and that is the whole reason this is a method rather than a raw
          settings read. A row is WRITTEN keyed on the socket the adopt
          path saw and is READ back by ``owned_instances`` keyed on
          whatever this returns; if those two ever differ, the badge is
          answered from a socket nothing was written to and every adopted
          session reads as external. Following the socket the probe was
          ACTUALLY bound to keeps writer and reader on the same key AND
          keeps that key equal to reality. In production the values are
          identical; they diverge only where a harness pins a backend to
          a dedicated socket, and there following the pin is exactly
          right.
        Inputs: configured (str) - the already-resolved settings value,
          passed in rather than read here so this class stays free of a
          config import and needs no double to test.
        Output: str.
        Example: recorder.socket_name(configured="cloude")  # 'cloude'
        """
        if self._socket:
            return str(self._socket)
        return configured
