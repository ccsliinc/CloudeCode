"""The accent colour a theme manifest declares, and the cache over it.

Slice S2 of the ``session_manager`` decomposition, split out of
``theme_store`` because it is a genuinely separate job: ``ThemeStore``
answers "which theme does this session use", and this answers "what
colour is that theme". The first is per-session mutable state backed by
two writable files; this is a read-only memo over static bundled
manifests. Splitting them is also what keeps both modules under the
package's 500-line rule.

``--color-accent`` is the var read because every sampled ``theme.json``
defines it and it is already the session-identity accent elsewhere in
the client. A miss returns None and the client CSS falls through its own
``var(..., fallback)`` chain.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import structlog

logger = structlog.get_logger()


class ThemeAccents:
    """Resolves and memoizes the accent colour of a bundled theme.

    Description: owns the ``theme_id -> accent`` cache that used to be
      ``SessionManager._theme_accent_cache``. Theme manifests are static
      files that cannot change during a server's uptime, so the cache
      needs no invalidation and there is no eviction.

    Example:
        >>> ThemeAccents().accent_for_theme("matrix")
        '#00ff41'
    """

    def __init__(self) -> None:
        """Start with an empty cache.

        Description: no I/O happens until a theme is actually asked for.
        Inputs: none.
        Output: None.
        """
        #: THE ONE AND ONLY COPY of the accent memo. A cached ``None``
        #: is a real answer ("this theme declares no accent"), which is
        #: why every read below tests membership rather than truthiness.
        self.cache: dict[str, Optional[str]] = {}

    @staticmethod
    def themes_dir() -> Path:
        """The bundled themes root, ``client/css/themes/``.

        Description: computed from this file's location. This module
          lives at ``src/core/sessions/theme_accents.py``, so FOUR
          parent hops reach the repo root - one more than the three the
          loose method on ``src/core/session_manager.py`` needed, which
          is the kind of detail a file move breaks silently. Mirrors
          ``routes._bundled_themes_root``, kept duplicated rather than
          cross-imported to avoid a routes cycle.
        Inputs: none.
        Output: Path.
        Example: ThemeAccents.themes_dir() / "matrix" / "theme.json"
        """
        return (
            Path(__file__).resolve().parent.parent.parent.parent
            / "client"
            / "css"
            / "themes"
        )

    def accent_for_theme(self, theme_id: Optional[str]) -> Optional[str]:
        """The ``--color-accent`` value for a theme id, memoized.

        Description: reads ``client/css/themes/<id>/theme.json`` once per
          id and remembers the answer, INCLUDING a None answer. Reading a
          cached None as a miss would re-parse the manifest on every
          toast for every accent-less theme, which is the whole cost this
          cache exists to avoid.
        Inputs: theme_id (str | None).
        Output: str | None - None when the id is falsy, the manifest is
          missing, unreadable or malformed, or ``cssVars`` lacks the var.
        Example: accents.accent_for_theme("matrix")  # '#00ff41'
        """
        if not theme_id:
            return None
        if theme_id in self.cache:
            return self.cache[theme_id]

        manifest_path = self.themes_dir() / theme_id / "theme.json"
        accent: Optional[str] = None
        try:
            with manifest_path.open("r", encoding="utf-8") as fh:
                raw = json.load(fh)
            css_vars = raw.get("cssVars") if isinstance(raw, dict) else None
            if isinstance(css_vars, dict):
                val = css_vars.get("--color-accent")
                if isinstance(val, str) and val.strip():
                    accent = val.strip()
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            # A missing or broken manifest is a cosmetic miss, not a
            # fault: the client has a CSS fallback. Logged at debug so a
            # user-authored theme without an accent does not spam.
            logger.debug(
                "toast_theme_accent_read_failed",
                theme_id=theme_id,
                path=str(manifest_path),
                error=str(exc),
            )
            accent = None

        self.cache[theme_id] = accent
        return accent
