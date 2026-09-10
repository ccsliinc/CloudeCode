"""The composition root: one function that says what this application is.

Description at the top because it is the point of the module. Nothing in
this codebase assembles itself and nothing reaches through a manager to
get at something else. :func:`build_services` constructs every
collaborator in dependency order and hands back a frozen
:class:`AppServices`; ``lifespan`` calls it, puts the result on
``app.state.services``, and that is the whole boot wiring.

That single function is the test fixture, the boot path and the
documentation of what this application is made of, and there is exactly
one of it. See ``.claude/notes/backend-decomposition-plan.md`` section 3.

**THE MEASUREMENT THAT MAKES THIS AFFORDABLE.** ``src/`` has exactly ONE
construction site for the manager (``src/main.py``) against 37
``app.state.session_manager`` lookups. The manager is already reached
through ``app.state``, which is a service locator with 15 untyped
entries on it. That is not a god object problem, it is a container
waiting to be named.

**WHAT S0 DOES AND DOES NOT DO.** No behaviour moves here. The five
collaborators the shipped slices created are constructed HERE instead of
inside ``SessionManager.__init__``, with byte-identical arguments, and
handed in through the keyword-only seam those slices already added. The
facade keeps every name it had. What changes is who calls the
constructor, which is what later slices need in order to hand a
collaborator to a caller that has stopped going through the manager.

**ONE OBJECT, NEVER TWO.** ``services.themes is
services.session_manager._theme_store`` holds by CONSTRUCTION, not by
convention: the store is built once and passed in. Passing both a
``session_manager`` and a collaborator is refused outright rather than
resolved, because the resolution that reads best - "the explicit
collaborator wins" - is the one that produces two objects holding one
logical state, which is the shape of the bug that produced 22
``/sessions/list`` rows for 21 live panes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from src.core.live_ports import LiveSessionRecordStore, LiveSettings, SystemClock
from src.core.session_manager import SessionManager
from src.core.sessions.ports import Clock, SessionRecordStore, SettingsReader
from src.core.sessions.probe_health import ProbeHealthRecorder
from src.core.sessions.registry import SessionRegistry
from src.core.sessions.sidecars import AttachmentSidecars
from src.core.sessions.theme_store import ThemeStore
from src.core.sessions.toast_inbox import ToastInbox


@dataclass(frozen=True)
class AppServices:
    """Every process-wide collaborator and port, in one typed container.

    Description: FROZEN, so a caller cannot swap a collaborator out from
      under another caller at runtime. It replaces reaching through
      ``app.state.session_manager`` for something that was never the
      manager's business - a route that needs the toast inbox asks for
      ``services.toasts`` and gets exactly that.
    Inputs: see the field list; all required, all typed.
    Output: none, it is a container.
    Example: services.toasts.get(session_id)

    **THERE IS NO ``tmux`` FIELD, AND THAT IS A FINDING RATHER THAN AN
    OMISSION.** A ``TmuxReader`` is bound to ONE pane; each live session
    holds its own backend. There is no process-wide instance for this
    container to carry, so ``TmuxReader`` stays a parameter type with its
    own conformance test. Putting a per-pane object into a process-wide
    container is the same category error as keying unread state on a
    tmux NAME when the thing it describes is an INSTANCE, which this
    project has already paid for once.
    """

    #: The facade, until S9 deletes it. Present so ``lifespan`` and the
    #: 37 existing ``app.state.session_manager`` readers keep working
    #: while the slices migrate them one cluster at a time.
    session_manager: SessionManager

    #: S1's cluster: the tmux probe health scalars.
    probe_health: ProbeHealthRecorder
    #: S2's cluster: the pinned-theme map, the project dotfile, the accents.
    themes: ThemeStore
    #: S3's cluster: per-session toast records and the startup queue.
    toasts: ToastInbox
    #: S4's cluster: per-session log buffers and command counters.
    registry: SessionRegistry
    #: S5's cluster: idle watchers, adopt FIFO offsets, pending commands.
    sidecars: AttachmentSidecars

    #: Wall-clock and monotonic time, so a timing rule can be tested
    #: without sleeping.
    clock: Clock
    #: The handful of settings values a collaborator may read.
    settings_reader: SettingsReader
    #: How the ``sessions`` rows in ``cloude.db`` are reached.
    records: SessionRecordStore


def build_services(
    *,
    settings_reader: Optional[SettingsReader] = None,
    clock: Optional[Clock] = None,
    records: Optional[SessionRecordStore] = None,
    probe_health: Optional[ProbeHealthRecorder] = None,
    themes: Optional[ThemeStore] = None,
    toasts: Optional[ToastInbox] = None,
    registry: Optional[SessionRegistry] = None,
    sidecars: Optional[AttachmentSidecars] = None,
    session_manager: Optional[SessionManager] = None,
) -> AppServices:
    """Construct the application's collaborators in dependency order.

    Description: THE one construction site. Every parameter is a
      keyword with a production default, so a test overrides the one
      thing it cares about and gets the rest real - which is what keeps a
      hermetic double from being a slice's only evidence. Construction
      order is settings, then clock, then the record store (which needs
      settings), then the five collaborators (two of which need
      settings), then the facade, which is handed all five.
    Inputs: settings_reader (SettingsReader | None) - defaults to
      :class:`~src.core.live_ports.LiveSettings`. clock (Clock | None) -
      defaults to :class:`~src.core.live_ports.SystemClock`. records
      (SessionRecordStore | None) - defaults to
      :class:`~src.core.live_ports.LiveSessionRecordStore` over the
      resolved settings reader. probe_health, themes, toasts, registry,
      sidecars - the five collaborators, each default-constructed when
      None. session_manager (SessionManager | None) - an ALREADY BUILT
      facade to wrap; mutually exclusive with every collaborator
      argument, see below.
    Output: AppServices.
    Example: build_services(clock=FrozenClock(at=1_700_000_000.0))

    Raises:
        ValueError: when ``session_manager`` is passed together with any
            of the five collaborator arguments. There is no correct
            merge: the given manager already holds its own five, so
            honouring the collaborator argument would put two objects
            behind one logical state and every value assertion would
            still pass until the first write through the wrong one. A
            refusal costs the caller one line; a merge costs a silent
            fork.
    """
    collaborator_args = {
        "probe_health": probe_health,
        "themes": themes,
        "toasts": toasts,
        "registry": registry,
        "sidecars": sidecars,
    }
    if session_manager is not None:
        conflicting = sorted(k for k, v in collaborator_args.items() if v is not None)
        if conflicting:
            raise ValueError(
                "build_services got session_manager together with "
                f"{conflicting}; a manager already owns its collaborators, so "
                "honouring both would create two objects holding one state"
            )

    resolved_settings: SettingsReader = (
        settings_reader if settings_reader is not None else LiveSettings()
    )
    resolved_clock: Clock = clock if clock is not None else SystemClock()
    resolved_records: SessionRecordStore = (
        records
        if records is not None
        else LiveSessionRecordStore(settings_reader=resolved_settings)
    )

    if session_manager is not None:
        # READ the five off the manager rather than building any. This is
        # the only branch where the manager pre-exists, and it must not
        # mint a sixth object of any kind.
        manager = session_manager
        resolved_probe = manager._probe_health
        resolved_themes = manager._theme_store
        resolved_toasts = manager._toast_inbox
        resolved_registry = manager._registry
        resolved_sidecars = manager._sidecars
    else:
        resolved_probe = (
            probe_health if probe_health is not None else ProbeHealthRecorder()
        )
        # THE BOUND METHOD IS THE CALLABLE, deliberately. ``ThemeStore``
        # takes a ``Callable[[], Path]`` and resolves it on every load and
        # save, which is what the loose ``_load_pinned_themes`` did.
        # Passing ``resolved_settings.pinned_themes_path`` rather than a
        # lambda around it keeps the number of places the path can be
        # resolved at one.
        resolved_themes = (
            themes
            if themes is not None
            else ThemeStore(pin_path=resolved_settings.pinned_themes_path)
        )
        resolved_toasts = toasts if toasts is not None else ToastInbox()
        # Same shape as the theme path, same reason: read on every
        # append, never captured, so a settings reload takes effect on a
        # live registry.
        resolved_registry = (
            registry
            if registry is not None
            else SessionRegistry(log_cap=resolved_settings.log_buffer_size)
        )
        resolved_sidecars = (
            sidecars if sidecars is not None else AttachmentSidecars()
        )
        manager = SessionManager(
            probe_health=resolved_probe,
            theme_store=resolved_themes,
            toast_inbox=resolved_toasts,
            registry=resolved_registry,
            sidecars=resolved_sidecars,
        )

    return AppServices(
        session_manager=manager,
        probe_health=resolved_probe,
        themes=resolved_themes,
        toasts=resolved_toasts,
        registry=resolved_registry,
        sidecars=resolved_sidecars,
        clock=resolved_clock,
        settings_reader=resolved_settings,
        records=resolved_records,
    )
