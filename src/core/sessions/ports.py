"""The four substitution points, as structural :class:`typing.Protocol`.

A collaborator in this package states what it needs as a PORT and is
handed an implementation by the composition root
(:mod:`src.core.composition`). A test hands it a different one. Nothing
here reaches for a module global, which is the whole point: the S2 near
miss was a collaborator that resolved ``settings`` itself, and had it
shipped it would have READ AND WRITTEN the owner's real
``~/.cloude-sessions`` on every pytest run, because the 41
``monkeypatch.setattr("src.core.session_manager.settings", ...)`` calls
in the suite bind a name that collaborator would never have looked at.

STRUCTURAL, NOT NOMINAL. A double satisfies one of these by SHAPE. There
is no base class to inherit and no mock framework involved, so a fake in
a test file and the real object in ``src/`` are interchangeable without
either knowing about the other.

**THE DANGER A PORT INTRODUCES, said out loud: a double agrees with
whatever it was built to agree with.** So every port here has a
conformance test in ``tests/test_ports_conformance.py`` that runs the
REAL implementation against the same assertions as the double. A slice
whose only evidence is a double is not proven. This repo has paid for
that twice - ``tests/test_boot_readopt.py`` is hermetic and its
``FakeBackend.attach_existing`` had no guard to fail, and
``tests/test_respawn_refreshes_pane_env.py`` exists because a mock
asserting two calls in order only tests its own arrangement.

**THE METHOD NAMES ARE THE ONES THE CODE ACTUALLY USES.** The plan
(``.claude/notes/backend-decomposition-plan.md`` section 3.2) sketched
``TmuxReader`` as ``list_sessions`` / ``capture_pane`` /
``pane_status_all``; the real ``TmuxBackend`` spells those
``discover_existing`` / ``capture_scrollback`` / ``list_pane_status_all``.
A Protocol written to the sketch would have been satisfied by nothing in
the tree, which is a rung that can never be observed to fire - the
failure this codebase names in its own CLAUDE.md. The code won.

This module imports NOTHING from this project at runtime, so it can
never take part in a cycle. The one project type it names
(``TmuxListing``) is imported under ``TYPE_CHECKING`` only.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional, Protocol, runtime_checkable

if TYPE_CHECKING:  # pragma: no cover - typing only, never imported at runtime
    from src.core.tmux_listing import TmuxListing


@runtime_checkable
class Clock(Protocol):
    """Wall-clock and monotonic time, as something a test can replace.

    Description: every timing rule in this codebase is currently
      untestable without sleeping - ``STARTUP_HOOK_GRACE_SECONDS = 20``,
      ``WORKING_HEARTBEAT_TIMEOUT_SECONDS``,
      ``PERMISSION_TAIL_GRACE_SECONDS``. A collaborator that takes a
      Clock can be walked forward twenty seconds in a microsecond.
    Inputs: none, it is a type.
    Output: none, it is a type.
    Example: ``def __init__(self, *, clock: Clock) -> None: ...``

    THE TWO ARE NOT INTERCHANGEABLE and both are here for that reason.
    ``now()`` is epoch seconds and is what a stored timestamp is compared
    against; ``monotonic()`` cannot go backwards and is what a duration
    is measured with. Using ``now()`` for a duration is how a clock
    adjustment turns a 200 ms operation into a negative one.
    """

    def now(self) -> float:
        """Seconds since the epoch, as :func:`time.time` reports them."""
        ...

    def monotonic(self) -> float:
        """A never-decreasing counter, as :func:`time.monotonic` reports it."""
        ...


@runtime_checkable
class SettingsReader(Protocol):
    """The handful of settings values a collaborator actually needs.

    Description: NOT a convenience. This is the S2 near-miss fix. Fifteen
      modules under ``src/core/`` import the module-level ``settings``
      singleton today; a collaborator that does the same cannot be
      pointed at a throwaway directory by the suite's existing
      monkeypatches, so it reads and writes the owner's real home.
      Taking the values through a constructor argument makes that
      impossible rather than merely discouraged.
    Inputs: none, it is a type.
    Output: none, it is a type.
    Example: ``ThemeStore(pin_path=reader.pinned_themes_path)``

    Deliberately SMALL. It grows one method at a time, when a
    collaborator genuinely needs one, because a reader that mirrored the
    whole ``Settings`` surface would be the singleton again wearing a
    protocol.
    """

    def pinned_themes_path(self) -> Path:
        """Where ``pinned_themes.json`` lives, resolved at each call."""
        ...

    def log_buffer_size(self) -> int:
        """The maximum number of lines one session's log buffer may hold."""
        ...

    def state_dir(self) -> Path:
        """The application state directory that holds ``cloude.db``."""
        ...

    def session_metadata_path(self) -> Path:
        """Where ``session_metadata.json`` lives, resolved at each call.

        Added by slice S3 for ``OwnedTmuxLedger``. Resolved per call
        rather than captured, because the file RELOCATES itself out of
        the legacy log directory on its next write.
        """
        ...


@runtime_checkable
class TmuxReader(Protocol):
    """The READ side of a tmux pane, and only the read side.

    Description: the write side stays on ``SessionBackend``
      (``src/core/session_backend.py``), which is a genuine is-a over a
      stable base and remains the one legitimate ABC in this design.
      Splitting the read half out is what lets a status ladder be tested
      without a real socket, and it is the half that is called on the
      render path.
    Inputs: none, it is a type.
    Output: none, it is a type.
    Example: ``def resolve(self, tmux: TmuxReader) -> str: ...``

    **A TmuxReader IS BOUND TO ONE PANE, so there is no process-wide
    instance of it and it is deliberately NOT a field on
    ``AppServices``.** Each live session holds its own backend. Putting a
    per-pane object into a process-wide container would be the same
    category error as keying unread state on a tmux NAME when the thing
    it describes is an INSTANCE, which this project has already paid for.
    """

    def is_alive(self) -> bool:
        """Does the tmux session this reader is bound to still exist.

        Note the three-outcome trap this signature cannot express, and
        which every caller must handle itself: a bool cannot tell "no
        such session" apart from "tmux is missing, timed out or errored".
        ``src/core/session_recreate_presence.py`` exists because acting
        on that False would spawn a second tmux beside a healthy one.
        """
        ...

    def discover_existing(self) -> "TmuxListing":
        """List the sessions on this reader's socket."""
        ...

    def list_pane_status_all(self) -> "TmuxListing":
        """One bulk pane-status probe for every session on the socket."""
        ...

    def capture_scrollback(self, lines: int = 3000) -> bytes:
        """The pane's scrollback, newest ``lines`` lines, as raw bytes."""
        ...

    def capture_visible_screen(self) -> bytes:
        """Only what is on the pane's screen right now, as raw bytes."""
        ...


@runtime_checkable
class SessionRecordStore(Protocol):
    """How a collaborator reaches the ``sessions`` rows in ``cloude.db``.

    Description: the 26 methods on the manager that touch tmux AND
      sqlite each open their own connection through one of two private
      helpers, both of which resolve ``settings.get_state_dir()`` off a
      module global. THAT pair is the genuine seam, so it is what this
      port names.
    Inputs: none, it is a type.
    Output: none, it is a type.
    Example: ``row = records.get_instance(socket='cloude', name='x', epoch=1)``

    **WHY ``claim_instance`` AND THE ``record_*`` WRITERS ARE NOT HERE,
    although the plan named them.** They are not members of any object.
    ``get_instance`` is a module function in ``src/core/session_store.py``,
    ``claim_instance`` is a module function in
    ``src/core/session_identity.py``, and the nine ``record_*`` functions
    are spread over seven unrelated modules with no shared shape. Naming
    them in a Protocol would produce members nothing conforms to and no
    conformance test could exercise. They join this port when the slice
    that owns their call sites (S8) gives them a call site to be
    substituted at. Declaring them now would be a ladder rung that has
    never been observed to fire.

    **A None CONNECTION IS AN ANSWER, AND IT IS NOT "NOTHING IS
    STORED".** Both vendors return None when the datastore is absent,
    locked or pre-v2. Every caller in this codebase already distinguishes
    "the datastore has no opinion" from "the datastore says no", and an
    implementation of this port that raised instead would break that
    distinction on the render path.
    """

    def read_connection(self) -> Optional[sqlite3.Connection]:
        """Open ``cloude.db`` for a best-effort read, or answer None.

        NEVER creates the file. This serves the render path and must not
        bring a database into existence as a side effect of drawing a
        badge.
        """
        ...

    def write_connection(self) -> Optional[sqlite3.Connection]:
        """Open ``cloude.db`` for writing, or answer None.

        Also never creates the file: an adoption that silently birthed a
        fresh empty datastore would lose the install's history rather
        than record a claim into it.
        """
        ...

    def get_instance(
        self, *, socket: str, name: str, epoch: Optional[int]
    ) -> Optional[dict[str, Any]]:
        """The ``sessions`` row for one tmux instance triple, or None.

        Keyed on the triple and never on the name alone, because a name
        is reusable and this app re-mints them.
        """
        ...
