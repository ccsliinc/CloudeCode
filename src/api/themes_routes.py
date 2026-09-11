"""Theme manifest discovery over the bundled and user theme roots.

Scans ``client/css/themes/*/theme.json`` (bundled) and the user themes
directory. Each manifest is try-parsed and a failure is LOGGED AND
SKIPPED - never a 500, and never silently substituted with claude
defaults. The endpoint must always return a usable list.

An ``id`` that disagrees with its directory name is a manifest error and
the theme is skipped, so two themes in different folders cannot collide
on one id.

``_bundled_themes_root`` derives its path from ``__file__``. This module
sits at the same depth as the ``src/api/routes.py`` it was split out of,
so the ``parents[2]`` walk is unchanged; moving it deeper would silently
point the scan at the wrong directory.
"""

import json
import os
import structlog
from fastapi import APIRouter, Depends
from pathlib import Path
from src.api.auth import require_auth
from src.models import ThemeManifest
from typing import List, Optional

logger = structlog.get_logger()
router = APIRouter()


# ---------------------------------------------------------------------------
# Theme manifest discovery (Phase 2)
# ---------------------------------------------------------------------------
# Endpoint scans two roots:
#   1. `client/css/themes/*/theme.json`  → bundled, ships with the app
#   2. `<user_themes_dir>/*/theme.json`  → user-authored, default location is
#      `~/Library/Application Support/cloude-code-menubar/themes/`
#
# Each `theme.json` is try-parsed against `ThemeManifest`. Failures are
# LOGGED-AND-SKIPPED - never 500, never silently substituted with claude
# defaults. The endpoint must always return a usable list (possibly empty
# in pathological cases; the client has its own claude fallback).
#
# `id` mismatch (manifest.id != directory name) is treated as a manifest
# error: skip + log. This avoids two themes colliding on the same id when
# they live in different folders.
def _bundled_themes_root() -> Path:
    """Return repo's `client/css/themes/` dir. Matches the static mount."""
    # routes.py lives at src/api/routes.py - parent.parent.parent = repo root
    return Path(__file__).resolve().parent.parent.parent / "client" / "css" / "themes"


def _user_themes_root() -> Optional[Path]:
    """Resolve user themes dir from settings/env, default macOS Application
    Support path. Returns None when no resolved path exists on disk.
    """
    # Phase 6 will wire ThemesConfig.user_themes_dir into Settings; for Phase
    # 2 we honor an env override or fall back to the documented macOS path.
    env_dir = os.environ.get("CLOUDE_USER_THEMES_DIR")
    if env_dir:
        p = Path(env_dir).expanduser()
        return p if p.is_dir() else None
    default = Path.home() / "Library" / "Application Support" / "cloude-code-menubar" / "themes"
    return default if default.is_dir() else None


def _load_manifest(theme_dir: Path, source: str) -> Optional[ThemeManifest]:
    """Try-parse one theme.json. Return None on any error (logged)."""
    manifest_path = theme_dir / "theme.json"
    if not manifest_path.is_file():
        return None
    try:
        with manifest_path.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as e:
        # UnicodeDecodeError is NOT an OSError (it's a ValueError subclass)
        # - explicitly catch it so binary garbage masquerading as a
        # theme.json gets logged + skipped instead of 500'ing the
        # endpoint. Other ValueErrors are intentionally left to surface
        # since they'd indicate a real bug in our code, not bad input.
        logger.warning(
            "theme_manifest_parse_failed",
            path=str(manifest_path),
            error=str(e),
        )
        return None

    # Server stamps `source`. Reject any client-supplied source value to keep
    # the contract one-way.
    raw["source"] = source

    try:
        manifest = ThemeManifest(**raw)
    except Exception as e:
        logger.warning(
            "theme_manifest_validation_failed",
            path=str(manifest_path),
            error=str(e),
        )
        return None

    # Enforce id == directory name. A mismatch is almost always a copy-paste
    # bug; surfacing it as a skip + log avoids silent collisions.
    if manifest.id != theme_dir.name:
        logger.warning(
            "theme_manifest_id_dir_mismatch",
            manifest_id=manifest.id,
            dir_name=theme_dir.name,
            path=str(manifest_path),
        )
        return None

    # A declared-but-missing themeCss is a manifest error, not a silent
    # no-op. Before 2026-08-19 ``ThemeManifest`` had no ``themeCss`` field
    # at all, so a manifest could declare one and the value would just be
    # dropped by pydantic as an unrecognized extra key - the exact same
    # silent-loss shape as the audio-block bug documented on
    # ``ThemeAudioManifest``. Now that the field exists, a theme that
    # declares it must actually ship the file; skip + log loudly rather
    # than let the theme through with a reference to nothing.
    if manifest.themeCss:
        theme_css_path = theme_dir / manifest.themeCss
        if not theme_css_path.is_file():
            logger.warning(
                "theme_manifest_themecss_missing",
                theme_id=manifest.id,
                theme_css=manifest.themeCss,
                path=str(theme_css_path),
            )
            return None

    return manifest


def _scan_themes_root(root: Optional[Path], source: str) -> List[ThemeManifest]:
    """Scan one root for theme.json files. Returns valid manifests only."""
    if root is None or not root.is_dir():
        return []
    out: List[ThemeManifest] = []
    seen_ids = set()
    try:
        entries = sorted(root.iterdir(), key=lambda p: p.name.lower())
    except OSError as e:
        logger.warning("themes_root_scan_failed", root=str(root), error=str(e))
        return []
    for child in entries:
        if not child.is_dir():
            continue
        if child.name.startswith("."):
            continue
        m = _load_manifest(child, source)
        if m is None:
            continue
        if m.id in seen_ids:
            logger.warning(
                "theme_duplicate_id_skipped",
                id=m.id,
                root=str(root),
            )
            continue
        seen_ids.add(m.id)
        out.append(m)
    return out


@router.get(
    "/themes",
    response_model=List[ThemeManifest],
    dependencies=[Depends(require_auth)],
)
async def list_themes() -> List[ThemeManifest]:
    """List discovered theme manifests (bundled + user).

    Bundled themes are sorted first (alphabetical by name within each group).
    Malformed manifests are skipped with a warning log - never 500.
    The client has its own Claude fallback, so an empty list is acceptable
    in degraded states.

    Cross-root id collision rule (Phase 9): a user theme whose id matches
    a bundled theme id is silently dropped with a warning. Bundled wins.
    Rationale: lets us ship breaking-change updates to bundled themes
    without a stale user-cloned copy shadowing them, and avoids ambiguity
    in the selector UI.
    """
    bundled = _scan_themes_root(_bundled_themes_root(), "builtin")
    user = _scan_themes_root(_user_themes_root(), "user")
    bundled.sort(key=lambda m: m.name.lower())
    user.sort(key=lambda m: m.id.lower())

    bundled_ids = {m.id for m in bundled}
    deduped_user: List[ThemeManifest] = []
    for m in user:
        if m.id in bundled_ids:
            logger.warning(
                "theme_user_shadowed_by_builtin",
                id=m.id,
                reason="user theme id collides with a bundled theme; bundled wins",
            )
            continue
        deduped_user.append(m)

    return bundled + deduped_user
