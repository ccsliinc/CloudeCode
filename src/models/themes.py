"""Choosing a theme, pinning one to a session, and the on-disk
``theme.json`` manifest the themes endpoint validates.
"""

from typing import Optional, Dict, Literal
from pydantic import BaseModel, Field, field_validator


class UpdatePinnedThemeRequest(BaseModel):
    """Request body for ``PATCH /sessions/{session_name}/pinned-theme``.

    SESSION-IDENTITY-V2: pin a theme id to a specific tmux session, or
    clear the pin by sending ``null``. The pinned theme overrides the
    user's global localStorage theme whenever the session is active.

    DEPRECATED in v0.7.0: superseded by ``UpdateThemeRequest`` (project-
    scoped via ``<working_dir>/.cc.theme``). This shape is kept for one
    release; the deprecated alias route forwards through to the new code
    path. Will be removed in v0.8.x.
    """
    pinned_theme: Optional[str] = Field(
        None,
        description="Theme id to pin to this session (None/null clears the pin)",
    )


class UpdateThemeRequest(BaseModel):
    """Request body for ``PATCH /sessions/{session_name}/theme`` (v0.7.0+).

    Project-scoped theme persistence: the theme id is written to
    ``<session.working_dir>/.cc.theme`` so two browsers / two machines
    pointed at the same project see the same theme without round-tripping
    a per-machine cache. ``theme_id=None`` or empty deletes the dotfile
    (clears the pin).
    """
    theme_id: Optional[str] = Field(
        None,
        description="Theme id to pin to this project's working dir (None/empty clears)",
    )


# Theme system models (Phase 2 - see plan section "Architecture B" / "F").
#
# A ThemeManifest is the JSON shape of `theme.json` - one per bundled theme
# directory under `client/css/themes/<id>/` and one per user theme directory
# under `<user_themes_dir>/<id>/`. The /api/v1/themes endpoint validates each
# manifest with this model: malformed manifests are SKIPPED (logged warning,
# not 500'd, not silently substituted with claude defaults). The endpoint
# stamps `source` server-side so the client can distinguish bundled vs user.
class ThemeAudioManifest(BaseModel):
    """The optional `audio` block of a theme.json.

    THIS MODEL IS LOAD-BEARING FOR SOUND, and its absence is why the app was
    silent for four rounds of fixes. `/api/v1/themes` declares
    `response_model=List[ThemeManifest]`, so FastAPI serialises exactly the
    fields declared on that model and nothing else. `theme.json` carried a
    perfectly good `audio` block, Pydantic dropped it as an extra key at
    parse time, and the client's `Themes.applyTheme()` then called
    `ThemeAudio.setTheme(m.audio || null)` with `undefined` on every single
    theme. No node was ever built, so every downstream fix (format order,
    gain budget, mime type, element volume) was fixing a graph that did not
    exist. Nothing errored: the UI honestly reported "this theme has no
    track yet", which is exactly what the API had told it.

    Adding a field to a client-facing manifest means adding it HERE too.

    Values are clamped rather than rejected. A typo in one number must not
    take the whole theme out of the selector, because `_load_manifest()`
    drops a manifest that fails validation.
    """
    src: str = Field(..., description="Same-origin URL of the primary track")
    srcFallback: Optional[str] = Field(
        None, description="Same-origin URL tried when `src` fails to decode"
    )
    volume: float = Field(
        0.5, description="Target gain after fade-in, 0..1; clamped, not rejected"
    )
    fadeMs: int = Field(
        1500, description="Crossfade duration in ms; negatives clamp to 0"
    )

    @field_validator("volume")
    @classmethod
    def _clamp_volume(cls, v: float) -> float:
        """Clamp the target gain into 0..1.

        :param v: the raw manifest value.
        :returns: the value constrained to 0..1.
        """
        return max(0.0, min(1.0, v))

    @field_validator("fadeMs")
    @classmethod
    def _clamp_fade(cls, v: int) -> int:
        """Clamp the crossfade duration to a non-negative number of ms.

        :param v: the raw manifest value.
        :returns: the value constrained to >= 0.
        """
        return max(0, v)


class ThemeManifest(BaseModel):
    """Theme manifest descriptor.

    `id` MUST match the directory name on disk - the discovery code uses the
    dir name as the canonical id and rejects manifests whose `id` field
    disagrees, since otherwise two themes could collide on the same id while
    living in different folders.
    """
    id: str = Field(..., description="Theme id; MUST match the on-disk directory name")
    name: str = Field(..., description="Human-readable display name shown in the selector")
    description: str = Field(..., description="One-line description")
    author: Optional[str] = Field(None, description="Theme author")
    version: Optional[str] = Field(None, description="Theme version (semver-ish)")
    cssVars: Dict[str, str] = Field(
        default_factory=dict,
        description="Map of CSS custom-property name -> value, applied on :root",
    )
    xterm: Dict[str, str] = Field(
        default_factory=dict,
        description="xterm.js theme object (background/foreground/ANSI palette)",
    )
    effects: Optional[str] = Field(
        None,
        description="Optional filename of an effects.js module relative to the theme dir",
    )
    effectsDigest: Optional[str] = Field(
        None,
        description=(
            "Server-stamped sha256 hex of the ``effects`` file's bytes, or "
            "null when the theme declares no script or the file could not be "
            "read. SCRIPT CONSENT IS BOUND TO THIS VALUE: an 'always allow' "
            "records the digest it was granted for, so editing effects.js "
            "revokes the grant instead of inheriting it. A null here is "
            "therefore not a neutral absence - for a user theme that DOES "
            "declare a script it means the bytes could not be named, and "
            "``theme_script_consent.decide`` refuses to run it. Client-supplied "
            "values are ignored; the server overwrites this field on every scan."
        ),
    )
    themeCss: Optional[str] = Field(
        None,
        description=(
            "Optional filename of a theme.css stylesheet relative to the theme "
            "dir. The client never wires this up to a <link href> - all visual "
            "theming ships through cssVars and effects.js instead, verified "
            "2026-08-19 (removed dead client/css/themes/*/theme.css files and "
            "the unused #theme-css <link> in client/index.html). This field is "
            "kept only so a manifest that still declares one and does not ship "
            "the file fails loudly in _load_manifest instead of the file being "
            "silently dropped by response_model serialization - the same class "
            "of bug that once ate every theme's audio block."
        ),
    )
    audio: Optional[ThemeAudioManifest] = Field(
        None,
        description="Optional background music block; absent means a silent theme",
    )
    source: Literal["builtin", "user"] = Field(
        ..., description="Where the manifest was discovered - server-stamped"
    )
