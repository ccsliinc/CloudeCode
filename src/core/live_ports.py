"""The production implementations of the four ports.

Each class here satisfies one Protocol in
``src/core/sessions/ports.py`` and is handed out by
:func:`src.core.composition.build_services`. ``TmuxReader`` has no class
in this module on purpose: ``TmuxBackend`` already satisfies it by
shape, which is the entire reason the ports are structural rather than
nominal. Writing an adapter for it would add a layer that could only
ever disagree with the thing it wraps.

**WHY THIS MODULE IS NOT UNDER ``src/core/sessions/``.**
:class:`LiveSettings` reads the ``settings`` name out of
``src.core.session_manager``'s namespace, and rule 1 of that package
(``tests/test_sessions_package_rules.py``) forbids anything in there
from importing the facade. The rule is right and this module moves
rather than bending it. Reaching the same module through ``importlib``
to slip past an AST check would be worse than the import: it would keep
the dependency and lose the enforcement.

**AND WHY IT READS THAT NAME AT ALL, WHICH IS THE UNCOMFORTABLE PART.**
41 places in ``tests/`` do
``monkeypatch.setattr("src.core.session_manager.settings", stub)``. That
rebinds a name in ONE module's namespace; ``src.config.settings`` still
points at the real object. So a settings reader that resolved
``src.config.settings`` would be invisible to every one of those
patches, and the theme tests would read and WRITE the owner's real
``~/.cloude-sessions/pinned_themes.json`` during a plain pytest run.
That is not a hypothetical: slice S2 nearly shipped exactly it.

DELETE AFTER S5, when ``src/config.py`` becomes a package and the
singleton stops being the thing the suite patches. Until then this
indirection is the only spelling that keeps the existing seam intact,
and it is written down here rather than discovered later.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

import structlog

from src.core.sessions.ports import Clock, SessionRecordStore, SettingsReader

logger = structlog.get_logger()


class SystemClock:
    """The real clock, satisfying :class:`~src.core.sessions.ports.Clock`.

    Description: two one-line reads of the standard library, kept as a
      class so the production wiring and a test double are the same
      shape. No state, no configuration, no construction arguments.
    Inputs: none.
    Output: none.
    Example: SystemClock().monotonic() < SystemClock().monotonic()
    """

    def now(self) -> float:
        """Seconds since the epoch.

        Description: :func:`time.time`, unmodified. Comparable against a
          stored timestamp; NOT safe to subtract for a duration, because
          it can move backwards.
        Inputs: none.
        Output: float.
        Example: SystemClock().now() > 1_700_000_000
        """
        return time.time()

    def monotonic(self) -> float:
        """A counter that never decreases.

        Description: :func:`time.monotonic`, unmodified. The only safe
          thing to measure a duration with.
        Inputs: none.
        Output: float.
        Example: end - start  # a real elapsed time
        """
        return time.monotonic()


class LiveSettings:
    """The real settings, read through the name the suite can patch.

    Description: satisfies
      :class:`~src.core.sessions.ports.SettingsReader` by resolving
      ``src.core.session_manager.settings`` on EVERY call. Late lookup is
      the whole mechanism, not an implementation detail: an early bind
      would capture whatever object existed at construction time and a
      later ``monkeypatch.setattr`` would never be seen.
    Inputs: none.
    Output: none.
    Example: LiveSettings().pinned_themes_path()

    See this module's docstring for why the name lives over there and
    when this class is deleted.
    """

    @staticmethod
    def _settings() -> Any:
        """The live ``Settings`` object, as ``session_manager`` currently sees it.

        Description: imported INSIDE the call rather than at module
          scope, so this module can be imported before the facade is and
          so the attribute is read at use time. ``sys.modules`` makes the
          repeat cost a dict lookup.
        Inputs: none.
        Output: Any - the ``Settings`` instance, or whatever a test has
          bound in its place.
        Example: LiveSettings._settings().log_buffer_size
        """
        from src.core import session_manager

        return session_manager.settings

    def pinned_themes_path(self) -> Path:
        """Where ``pinned_themes.json`` lives.

        Description: resolved per call, matching what the loose
          ``_load_pinned_themes`` / ``_save_pinned_themes`` did before
          the theme cluster moved.
        Inputs: none.
        Output: Path.
        Example: LiveSettings().pinned_themes_path().name  # 'pinned_themes.json'
        """
        return self._settings().get_pinned_themes_path()

    def log_buffer_size(self) -> int:
        """The per-session log-buffer line cap.

        Description: read on every append, never captured, because a
          settings reload has to take effect on a live registry.
        Inputs: none.
        Output: int.
        Example: LiveSettings().log_buffer_size()  # 1000
        """
        return self._settings().log_buffer_size

    def state_dir(self) -> Path:
        """The application state directory that holds ``cloude.db``.

        Description: the suite points this at a throwaway directory via
          ``CLOUDE_STATE_DIR`` in ``tests/conftest.py``, so reading it
          through here is safe by two mechanisms rather than one.
        Inputs: none.
        Output: Path.
        Example: LiveSettings().state_dir() / 'cloude.db'
        """
        return Path(self._settings().get_state_dir())

    def session_metadata_path(self) -> Path:
        """Where ``session_metadata.json`` lives.

        Description: resolved per call, matching what the loose
          ``_load_session_metadata`` / ``_write_metadata_atomic`` did
          before the owned-tmux cluster moved. The file relocates itself
          out of the legacy log directory on its next write, so a value
          captured once would go stale at exactly the moment it matters.
        Inputs: none.
        Output: Path.
        Example: LiveSettings().session_metadata_path().name
        """
        return self._settings().get_session_metadata_path()


class LiveSessionRecordStore:
    """The real ``cloude.db``, satisfying :class:`SessionRecordStore`.

    Description: the two connection vendors are the manager's
      ``_datastore_connection`` and ``_writable_datastore_connection``
      moved behind a port, byte-for-byte in behaviour including their
      failure posture. Neither creates the file, both answer None rather
      than raising, and the log level differs between them for the same
      reason it always has: a render-path miss is debug, an adopt-path
      miss is a warning the user may need to act on.
    Inputs: settings_reader (SettingsReader) - where the state directory
      comes from. Required, keyword-only: a default here would be a
      second way to find the database.
    Output: none.
    Example: LiveSessionRecordStore(settings_reader=LiveSettings())

    NOTHING CALLS THIS YET, and that is deliberate for S0, whose whole
    claim is that no behaviour moves. The manager keeps its own private
    helpers until the slice that owns those call sites migrates them.
    Two spellings of one read is exactly the drift this plan is about, so
    that slice DELETES the private pair rather than leaving both.
    """

    def __init__(self, *, settings_reader: SettingsReader) -> None:
        """Bind the store to a way of finding the state directory.

        Inputs: settings_reader (SettingsReader).
        Output: None.
        Example: LiveSessionRecordStore(settings_reader=LiveSettings())
        """
        self._settings_reader = settings_reader

    def _open(self, *, warn: bool) -> Optional[sqlite3.Connection]:
        """Open ``cloude.db`` if it is already there, else answer None.

        Description: ONE implementation for both vendors, because they
          differ only in how loudly they report a miss. Two copies of an
          open-if-present would be two places for a ``create=True`` to
          appear, and a datastore brought into existence by a render is
          how an install loses its history.
        Inputs: warn (bool) - True to log a failure at warning level,
          False for debug.
        Output: sqlite3.Connection | None.
        Example: self._open(warn=False)
        """
        try:
            from src.core.db import connect, db_path_for

            path = db_path_for(self._settings_reader.state_dir())
            if not Path(path).exists():
                return None
            return connect(path, create=False)
        except (sqlite3.Error, OSError, ImportError, AttributeError) as exc:
            # Never break the caller: every one of them treats None as
            # "the datastore has no opinion", which is a different answer
            # from "the datastore says no".
            if warn:
                logger.warning("record_store_unavailable", error=str(exc))
            else:
                logger.debug("record_store_unavailable", error=str(exc))
            return None

    def read_connection(self) -> Optional[sqlite3.Connection]:
        """Open the datastore for a best-effort read, or answer None.

        Description: serves the render path, so a miss is debug-level and
          the file is never created.
        Inputs: none.
        Output: sqlite3.Connection | None.
        Example: conn = store.read_connection()
        """
        return self._open(warn=False)

    def write_connection(self) -> Optional[sqlite3.Connection]:
        """Open the datastore for writing, or answer None.

        Description: serves explicit user actions on a booted app, so a
          miss is a warning. Still never creates the file.
        Inputs: none.
        Output: sqlite3.Connection | None.
        Example: conn = store.write_connection()
        """
        return self._open(warn=True)

    def get_instance(
        self, *, socket: str, name: str, epoch: Optional[int]
    ) -> Optional[dict[str, Any]]:
        """The ``sessions`` row for one tmux instance triple, or None.

        Description: opens its own read connection and closes it, so a
          caller never holds one. A datastore that cannot be opened
          yields None, which every caller in this codebase reads as "not
          having been able to look" rather than as "there is no row".
        Inputs: socket (str) - the tmux socket name. name (str) - the
          literal tmux session name. epoch (int | None) - the instance's
          ``#{session_created}``.
        Output: dict[str, Any] | None.
        Example: store.get_instance(socket='cloude', name='cloude_x', epoch=17)
        """
        conn = self.read_connection()
        if conn is None:
            return None
        try:
            from src.core.session_store import get_instance

            return get_instance(conn, socket=socket, name=name, epoch=epoch)
        except sqlite3.Error as exc:
            logger.debug("record_store_row_read_failed", error=str(exc))
            return None
        finally:
            try:
                conn.close()
            except sqlite3.Error as exc:  # a close failure is not a verdict
                logger.debug("record_store_close_failed", error=str(exc))


#: Named so a reader can check the module satisfies what it claims to,
#: and so the conformance test has one place to enumerate.
_PORT_IMPLEMENTATIONS: tuple[tuple[type, type], ...] = (
    (SystemClock, Clock),
    (LiveSettings, SettingsReader),
    (LiveSessionRecordStore, SessionRecordStore),
)
