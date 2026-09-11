"""Where a session's theme comes from, and who owns the pin map.

Slice S2 of the ``session_manager`` decomposition. This module holds
``ThemeStore``, the single owner of ``pinned_themes`` - the durable
per-tmux-name map mirrored in ``pinned_themes.json`` - and of the
``.cc.theme`` dotfile that supersedes it. Two neighbours are COMPOSED
rather than inherited, because a single class answering all three was
over the package's 500-line rule and they are genuinely three jobs:
``theme_accents`` answers "what colour is this theme" over a cache, and
``theme_dotfile`` is the stateless read and write of the file format.

**TWO SOURCES, AND THE DOTFILE WINS.** ``<working_dir>/.cc.theme`` is the
v0.7.0+ source of truth for a project's theme: it is keyed by directory,
so two browsers and two machines pointed at the same checkout converge
without round-tripping a per-machine cache. ``pinned_themes.json`` is
keyed by TMUX NAME and is retained only as a read-time back-compat
fallback for sessions pinned under v0.6.x. ``migrate_to_dotfile`` ferries
old entries forward on attach and adopt; it deliberately does NOT delete
the legacy entry, which decays as users re-pin.

**THE PIN PATH IS INJECTED, AND THAT IS NOT CEREMONY.** Every theme test
in this repo redirects state away from the developer's real
``~/.cloude-sessions`` by patching the ``settings`` name inside the
``session_manager`` module. A module here that imported ``settings``
directly would not see that patch, and would then LOAD FROM and WRITE TO
the owner's live pinned-theme file during a pytest run. So the path
arrives as a zero-argument callable resolved at CALL time, which keeps
the deferred semantics the loose methods had and keeps this class free of
a config import.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable, Optional

import structlog

from src.core.sessions import theme_dotfile
from src.core.sessions.theme_accents import ThemeAccents

logger = structlog.get_logger()


class ThemeStore:
    """Owns the pinned-theme map, the project dotfile, and their I/O.

    Description: the single owner of the theme cluster. ``SessionManager``
      holds one of these and keeps NO copy of either map - it reaches the
      pin map and the accent cache through properties that alias the very
      dict objects written here, so the two can never disagree. Two objects holding one logical map and kept in sync
      by hand is the shape of the bug that produced 22 ``/sessions/list``
      rows for 21 live panes.

    The class knows nothing about ``Session``, ``SessionBackend`` or the
      tmux socket: every method takes strings and paths. That is what lets
      it be exercised against a real temp directory with no manager at
      all, and it is why the live-session mirror half of
      ``SessionManager.set_pinned_theme`` (which walks ``backends`` and
      writes session metadata) stays on the facade - those are other
      slices' clusters.

    Example:
        >>> store = ThemeStore(pin_path=lambda: tmp / "pinned_themes.json")
        >>> store.set_pin("cloude_demo", "matrix")
        True
        >>> store.get_pin("cloude_demo")
        'matrix'
    """

    def __init__(
        self,
        *,
        pin_path: Callable[[], Path],
        accents: Optional[ThemeAccents] = None,
    ) -> None:
        """Start with an empty map and a way to find the pin file.

        Description: does NOT read the disk. Loading is an explicit
          ``load()`` call so the facade controls when it happens relative
          to the rest of its construction, and so a caller that only
          wants the dotfile side pays no I/O at all.
        Inputs: pin_path (Callable[[], Path]) - returns the location of
          ``pinned_themes.json``. A CALLABLE rather than a Path so the
          answer is resolved at each use, matching the
          ``settings.get_pinned_themes_path()`` call the loose methods
          made on every load and save. accents (ThemeAccents | None) -
          the manifest-accent memo, default-constructed when None. Both
          keyword-only, so neither can land in the other's slot.
        Output: None.
        Example: ThemeStore(pin_path=settings.get_pinned_themes_path)
        """
        self._pin_path = pin_path
        #: Durable per-tmux-name pins, the in-memory mirror of
        #: ``pinned_themes.json``. THE ONE AND ONLY COPY; the facade's
        #: ``pinned_themes`` property aliases this object rather than
        #: duplicating it.
        self.pinned_themes: dict[str, str] = {}
        #: COMPOSED, not inherited: the accent memo is its own object
        #: with its own cache, reached through ``accent_cache`` and
        #: ``accent_for``. The facade aliases that cache one hop further
        #: on, and it is still exactly one dict.
        self.accents: ThemeAccents = (
            accents if accents is not None else ThemeAccents()
        )

    @property
    def accent_cache(self) -> dict[str, Optional[str]]:
        """The composed accent memo's cache, aliased not copied.

        Description: exists so ``ThemeStore`` reads as the one theme
          collaborator while the accent memo stays a separate class.
          Returns the SAME dict object ``ThemeAccents`` writes into; a
          copy here would be the drift this decomposition exists to
          prevent, one layer down.
        Inputs: none.
        Output: dict[str, str | None].
        Example: store.accent_cache is store.accents.cache  # True
        """
        return self.accents.cache

    # ---- pinned_themes.json persistence (SESSION-IDENTITY-V2) ----------

    def load(self) -> None:
        """Load the per-tmux-name pinned-theme map from disk.

        Description: missing file = empty map (first run, or never
          pinned). Malformed file = empty map plus a warning; startup is
          never crashed over a corrupt non-critical preferences file.
          Values must be strings; any other type is dropped on load.
        Inputs: none.
        Output: None.
        Example: store.load()
        """
        path = self._pin_path()
        if not path.exists():
            return
        try:
            with open(path, "r") as f:
                raw = json.load(f)
            if not isinstance(raw, dict):
                logger.warning(
                    "pinned_themes_unexpected_shape",
                    type=type(raw).__name__,
                )
                return
            self.pinned_themes = {
                str(k): v for k, v in raw.items()
                if isinstance(v, str) and v
            }
            logger.info(
                "pinned_themes_loaded", count=len(self.pinned_themes)
            )
        except (OSError, ValueError, TypeError) as exc:
            # ValueError covers json.JSONDecodeError. Logged and
            # tolerated rather than raised: a preferences file the user
            # can re-create must not stop the server booting.
            logger.warning("failed_to_load_pinned_themes", error=str(exc))

    def save(self) -> None:
        """Persist the pinned-theme map atomically.

        Description: the same temp-then-``os.replace`` protocol
          ``_save_session_metadata`` and ``unread_store`` use, so a crash
          mid-write can never leave a half-written file at the canonical
          path. The ``fsync`` is best-effort; a filesystem that refuses
          it still gets an atomic rename.
        Inputs: none.
        Output: None.
        Example: store.save()
        """
        path = self._pin_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(path.suffix + ".tmp")
            with tmp.open("w") as f:
                json.dump(self.pinned_themes, f, indent=2)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
            os.replace(str(tmp), str(path))
        except (OSError, TypeError, ValueError) as exc:
            # Logged, never raised: losing a theme pin is a cosmetic
            # regression, and raising here would break the destroy and
            # rename paths that call this for cleanup.
            logger.error("failed_to_save_pinned_themes", error=str(exc))

    # ---- the legacy per-tmux-name map ----------------------------------

    def get_pin(self, tmux_name: Optional[str]) -> Optional[str]:
        """The persisted pin for a tmux session name, or None.

        Inputs: tmux_name (str | None) - a bare tmux session name.
        Output: str | None - the theme id, None when unset or the name
          is empty.
        Example: store.get_pin("cloude_demo")  # 'matrix'
        """
        if not tmux_name:
            return None
        return self.pinned_themes.get(tmux_name)

    def set_pin(self, tmux_name: Optional[str], theme_id: Optional[str]) -> bool:
        """Set or clear the pin for a tmux name, and persist either way.

        Description: ALWAYS PERSISTS when the name is usable - a cleared
          pin has to round-trip across a server restart exactly as a set
          one does, or the next boot re-applies a theme the user just
          removed.
        Inputs: tmux_name (str | None) - the pin handle. theme_id
          (str | None) - the theme, None or empty to clear.
        Output: bool - True when the map was consulted and written, False
          when the name was empty and nothing happened. The facade uses
          this to decide whether to mirror onto a live session.
        Example: store.set_pin("cloude_demo", None)  # clears, returns True
        """
        if not tmux_name:
            return False
        if theme_id:
            self.pinned_themes[tmux_name] = theme_id
        else:
            self.pinned_themes.pop(tmux_name, None)
        self.save()
        return True

    def discard_pin(self, tmux_name: Optional[str]) -> None:
        """Drop a name's pin entirely. No-op when absent.

        Description: called on the explicit destroy paths so a tmux name
          that is truly gone does not accumulate a dead pin forever.
          Distinct from ``set_pin(name, None)`` only in that it writes
          nothing when there was nothing to drop.
        Inputs: tmux_name (str | None).
        Output: None.
        Example: store.discard_pin("cloude_gone")
        """
        if tmux_name and tmux_name in self.pinned_themes:
            self.pinned_themes.pop(tmux_name, None)
            self.save()

    def rekey_pin(self, old_name: str, new_name: str) -> bool:
        """Move a pin from one tmux name to another, for a rename.

        Description: v0.7.0's project theme lives in ``.cc.theme`` keyed
          by working directory, so a rename does not affect it. The
          legacy JSON map is keyed by NAME and has to follow, or a
          downgrade to v0.6.x loses the pin.
        Inputs: old_name (str), new_name (str).
        Output: bool - True when a pin was moved and saved.
        Example: store.rekey_pin("cloude_old", "cloude_new")
        """
        if old_name not in self.pinned_themes:
            return False
        self.pinned_themes[new_name] = self.pinned_themes.pop(old_name)
        self.save()
        return True

    def prune_to_live(self, live_names: set[str]) -> list[str]:
        """Drop pins whose tmux session is measurably gone.

        Description: prevents indefinite growth from sessions the user
          destroyed outside our UI (``tmux -L cloude kill-session``).
          THE CALLER OWNS THE MEASUREMENT: this must only be called with
          the names from a listing that actually SUCCEEDED, because an
          empty set from a failed probe would wipe every pin the user
          has. The reconcile path gates on ``listing.ok`` before it gets
          here, which is what makes an empty set a measured zero rather
          than an unanswered question.
        Inputs: live_names (set[str]) - every tmux name the successful
          listing reported.
        Output: list[str] - the names pruned, sorted, empty when none.
        Example: store.prune_to_live({"cloude_a"})  # ['cloude_b']
        """
        if not self.pinned_themes:
            return []
        dead = sorted(
            name for name in self.pinned_themes if name not in live_names
        )
        if not dead:
            return []
        logger.info("pinned_themes_pruning_dead", names=dead)
        for name in dead:
            self.pinned_themes.pop(name, None)
        self.save()
        return dead

    # ---- the project dotfile, delegated to theme_dotfile ---------------

    #: The dotfile helpers are re-exposed as staticmethods so a caller
    #: holding a ThemeStore never has to know the format lives in another
    #: module. They are BOUND to the module functions, not re-implemented:
    #: one definition, two spellings.
    project_theme_path = staticmethod(theme_dotfile.project_theme_path)

    def get_project_theme(self, working_dir) -> Optional[str]:
        """Read ``<working_dir>/.cc.theme``.

        Description: THE DOTFILE ONLY. It cannot perform the legacy JSON
          fallback, which is keyed by tmux name and needs an argument
          this does not take; ``resolve_project_theme`` is the combined
          lookup.
        Inputs: working_dir (str | Path | None).
        Output: str | None.
        Example: store.get_project_theme(project)  # 'metal'
        """
        return theme_dotfile.read_project_theme(working_dir)

    def set_project_theme(self, working_dir, theme_id: Optional[str]) -> None:
        """Atomically write or clear ``<working_dir>/.cc.theme``.

        Description: RAISES on failure, unlike ``save()``. This is
          reached from a user action with a response to fail, so a write
          that did not happen must not report success.
        Inputs: working_dir (str | Path), theme_id (str | None) - None or
          empty clears the pin.
        Output: None.
        Raises: ValueError, FileNotFoundError, NotADirectoryError, OSError
          - see ``theme_dotfile.write_project_theme``.
        Example: store.set_project_theme(project, "metal")
        """
        theme_dotfile.write_project_theme(working_dir, theme_id)
    def resolve_project_theme(
        self, working_dir, tmux_name: Optional[str] = None
    ) -> Optional[str]:
        """The effective theme: dotfile first, then the legacy map.

        Description: the one call the create and adopt paths make, so
          neither has to write fallback glue. The ORDER is the whole
          contract - a dotfile beats a JSON pin, because the dotfile is
          what a second machine can see.
        Inputs: working_dir (str | Path | None). tmux_name (str | None) -
          the legacy key, omitted when there is none.
        Output: str | None.
        Example: store.resolve_project_theme(work, "cloude_demo")
        """
        dotfile = self.get_project_theme(working_dir)
        if dotfile is not None:
            return dotfile
        if tmux_name:
            return self.get_pin(tmux_name)
        return None

    @staticmethod
    def legacy_pin_key(
        tmux_session: Optional[str], session_id: Optional[str]
    ) -> Optional[str]:
        """The tmux name a legacy pin would have been filed under.

        Description: prefers the explicit ``tmux_session`` field, which
          is the canonical pin handle. Falls back to the trailing
          component of the session id for adopted rows written before
          the pin fix, where an id reads ``adopted:<tmux-name>``.
        Inputs: tmux_session (str | None), session_id (str | None).
        Output: str | None - None when neither yields a usable name.
        Example: ThemeStore.legacy_pin_key(None, "adopted:cloude_x")
          # 'cloude_x'
        """
        if tmux_session:
            return tmux_session
        sid = session_id or ""
        if sid.startswith("adopted:"):
            return sid[len("adopted:"):] or None
        return sid or None

    def migrate_to_dotfile(
        self,
        *,
        working_dir,
        tmux_session: Optional[str],
        session_id: Optional[str],
    ) -> bool:
        """Ferry a v0.6.x JSON pin into ``.cc.theme``. Best effort.

        Description: runs on attach and adopt, and writes only when the
          dotfile is ABSENT and a legacy pin exists for the resolved key.
          The legacy entry is intentionally left in place: this release
          still reads it as a fallback, and it decays as users re-pin.
          Every failure is logged and swallowed, because a failed theme
          migration must never break the attach path a user is waiting
          on; the comment is the reason the swallow is deliberate.
        Inputs: working_dir (str | Path | None) - the session's directory.
          tmux_session (str | None) and session_id (str | None) - the two
          halves of the legacy key, keyword-only so they cannot be
          swapped.
        Output: bool - True only on a completed migration.
        Example: store.migrate_to_dotfile(
            working_dir=w, tmux_session="cloude_x", session_id="ses_1")
        """
        if not working_dir:
            return False
        try:
            path = self.project_theme_path(working_dir)
            if path is None:
                return False
            # The dotfile is the newer format, so its presence means
            # there is nothing to migrate.
            if path.exists():
                return False
            # The directory must actually exist before we would write.
            if not path.parent.is_dir():
                logger.debug(
                    "migrate_pinned_theme_skipped_no_dir",
                    working_dir=str(working_dir),
                )
                return False
            tmux_name = self.legacy_pin_key(tmux_session, session_id)
            if not tmux_name:
                return False
            legacy_pin = self.pinned_themes.get(tmux_name)
            if not legacy_pin:
                return False
            self.set_project_theme(working_dir, legacy_pin)
            logger.info(
                "theme_migrated_to_dotfile",
                session_id=session_id,
                working_dir=str(working_dir),
                tmux_name=tmux_name,
                theme_id=legacy_pin,
            )
            return True
        except (OSError, ValueError, TypeError) as exc:
            # Deliberately tolerant: set_project_theme raises four
            # different errors for an unwritable directory, and none of
            # them is worth failing an attach over.
            logger.warning(
                "theme_migration_failed",
                session_id=session_id,
                working_dir=str(working_dir),
                error=str(exc),
            )
            return False

    # ---- theme manifest accents, composed from ThemeAccents ------------

    def accent_for_theme(self, theme_id: Optional[str]) -> Optional[str]:
        """The ``--color-accent`` value for a theme id, memoized.

        Description: delegates to the composed ``ThemeAccents``. Kept on
          this class so a caller holding the store never needs to know
          the accent memo is a separate object.
        Inputs: theme_id (str | None).
        Output: str | None - None when the id is falsy or the manifest
          does not declare an accent.
        Example: store.accent_for_theme("matrix")  # '#00ff41'
        """
        return self.accents.accent_for_theme(theme_id)

    def accent_for(
        self, working_dir, tmux_name: Optional[str]
    ) -> Optional[str]:
        """The accent colour for a session's effective theme.

        Description: the combined lookup the toast path calls on every
          record. The hot path is a dict read plus a cached lookup once
          the theme is known, which is cheap enough not to batch.
        Inputs: working_dir (str | Path | None), tmux_name (str | None).
        Output: str | None.
        Example: store.accent_for(work, "cloude_demo")  # '#00ff41'
        """
        return self.accent_for_theme(
            self.resolve_project_theme(working_dir, tmux_name)
        )
