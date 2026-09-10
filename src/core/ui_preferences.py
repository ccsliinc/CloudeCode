"""The typed, versioned ``ui_preferences`` block, and its validation.

WHAT BELONGS HERE, AND WHAT DELIBERATELY DOES NOT. The field set is the
"shared preference" column of ``docs/ui-preferences-inventory.md``, which
swept all 24 durable browser-stored keys and classified every one. A key
in the PER-VIEWER column is not here and must not be added: syncing one
of those pushes a single device's layout onto every other device the
user owns, and that is the failure this block is built to avoid rather
than cause. A preference that fails to sync is recoverable by the user
in a second; one that overwrites another device is not.

THE THREE AMBIGUOUS KEYS THAT ARE HERE, AND THE ONE THAT IS NOT. The
inventory recorded four dock/fold keys with BOTH readings rather than
guessing. Three are shared here:

- ``sidebar_pinned`` and ``config_editor_pinned``. Both are gated at 700px
  when RENDERED, which is what argued for keeping them local. What
  settles it is that neither can be AUTHORED below that width:
  ``session-sidebar-pin.js`` and ``config-drawer-pin.js`` both set
  ``btnEl.hidden = isMobile()`` and neither ``toggle()`` has any other
  caller in the tree, so a phone can never write a value that then
  un-docks a desktop. The value is a considered desktop intent, the gate
  stays local, which is exactly the "share the value, adapt the
  geometry" rule.
- ``launchpad_collapsed``. Three FIXED section ids, no viewport gate
  anywhere, no geometry - the same shape as ``sidebar_density``, which
  was never in doubt.

The fourth, ``cloude.session.sidebar`` (is the bar open right now), is
NOT here. It has no viewport gate at all and is written on every open
and every close from any width, including a phone tapping the bar shut,
so it records what one device is doing rather than what the user
prefers. Sharing it lets a phone close a desktop's sidebar.

UNKNOWN FIELDS ARE PRESERVED, NOT DROPPED. A newer client writing a
preference this server has never heard of must not lose it, and
downgrading must not destroy data, so an unrecognised key inside
``values`` is stored verbatim and passed back out untouched. It is
bounded rather than trusted: see ``validate_changes``.

NO SECRET EVER ENTERS THIS BLOCK. ``claude_tunnel_token`` and
``claude_refresh_token`` are refused by name, and so is anything whose
key reads like a credential, because the unknown-field passthrough above
is otherwise a place a client could park one.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field, field_validator

UI_PREFERENCES_KEY = "ui_preferences"
"""The top-level config.json key this block lives under."""

SCHEMA_VERSION = 1
"""Bumped only for a shape change readers must branch on. A new FIELD is
additive and needs no bump: an older client ignores what it does not
know and a newer server preserves what it does not know."""

SIDEBAR_DENSITIES = ("compact", "cozy", "detailed")
LAUNCHPAD_SECTION_IDS = ("running-sessions", "recent-sessions", "recent-projects")

MIN_MASTER_VOLUME = 0.35
"""Mirrors ``themeAudioSettings.js``'s floor. A value at or below zero is
silence the user cannot recover from by looking at the slider."""

THEME_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
MODEL_ID_RE = re.compile(r"^(?!-)[A-Za-z0-9._~/-]{1,120}$")
"""Mirrors ``providers.js``'s client-side check and the server's own
``MODEL_ID_PATTERN``. An empty string is legal and means "claude, no
OpenRouter model", which is what the client already stores."""

ARRANGEMENT_SCHEMA_VERSION = 1
MAX_REMEMBERED = 200
MAX_FOLDS = 100
"""The bounds ``session-sidebar-store.js`` already enforces locally,
restated here rather than inferred, so a hand-edited config cannot put
more into the block than the client will ever read back out."""

MAX_COLLAPSED_PATHS = 2000
MAX_UNKNOWN_FIELDS = 64
MAX_KEY_LENGTH = 128
MAX_UNKNOWN_VALUE_BYTES = 8192

_SECRET_KEY_NAMES = frozenset({"claude_tunnel_token", "claude_refresh_token"})
_SECRET_KEY_SHAPE = re.compile(r"(token|secret|password|passphrase|api[_-]?key)", re.I)


class SidebarArrangement(BaseModel):
    """The sidebar's pinned set, explicit order and folded sections.

    Attributes:
      v (int): the envelope version ``session-sidebar-store.js`` writes.
      pinned (list[str]): session names, newest-first, capped at
        ``MAX_REMEMBERED``.
      order (list[str]): session names in the user's explicit order,
        capped the same way.
      collapsed (list[str]): ``"pinned"``, ``"other"``, or a
        ``"g:<uuid>"`` group fold key. Validated STRUCTURALLY and never
        against a live group list, because the group list loads
        asynchronously after this parse runs - the same reason the
        client validates it that way.

    Names are session names, which are local and reusable. That is safe
    here in a way it would not be for identity: every device pointed at
    one install is looking at the SAME tmux sessions, and a name that
    resolves to nothing is already a case the sidebar handles (it keeps
    the remembered slot and marks it). A synced arrangement therefore
    degrades to "some remembered positions do not apply", never to a
    wrong session being pinned.
    """

    model_config = ConfigDict(extra="forbid")

    v: int = ARRANGEMENT_SCHEMA_VERSION
    pinned: List[str] = Field(default_factory=list)
    order: List[str] = Field(default_factory=list)
    collapsed: List[str] = Field(default_factory=list)

    @field_validator("pinned", "order")
    @classmethod
    def _bounded_names(cls, value: List[str]) -> List[str]:
        if len(value) > MAX_REMEMBERED:
            raise ValueError(f"at most {MAX_REMEMBERED} remembered session names")
        for name in value:
            if not name or len(name) > MAX_KEY_LENGTH:
                raise ValueError("a session name must be 1 to 128 characters")
        return value

    @field_validator("collapsed")
    @classmethod
    def _bounded_folds(cls, value: List[str]) -> List[str]:
        if len(value) > MAX_FOLDS:
            raise ValueError(f"at most {MAX_FOLDS} folded sections")
        for key in value:
            if key in ("pinned", "other"):
                continue
            if key.startswith("g:") and 2 < len(key) <= MAX_KEY_LENGTH:
                continue
            raise ValueError(f"unknown fold key '{key}'")
        return value


class UiPreferenceValues(BaseModel):
    """Every preference this server understands, all of them optional.

    ABSENT IS NOT A DEFAULT. Every field defaults to ``None``, meaning
    "the user has never set this here", and the client keeps using its
    own default. The server never fabricates a value, so hydrating from
    an empty block can never overwrite a real local setting with a
    server-side guess - which is the failure #44 names as one of the two
    that silently corrupt settings.
    """

    model_config = ConfigDict(extra="forbid")

    theme: Optional[str] = None
    audio_enabled: Optional[bool] = None
    audio_master_volume: Optional[float] = None
    launch_last_model: Optional[str] = None
    sidebar_density: Optional[str] = None
    sidebar_arrangement: Optional[SidebarArrangement] = None
    sidebar_pinned: Optional[bool] = None
    config_editor_pinned: Optional[bool] = None
    config_editor_collapsed: Optional[Dict[str, bool]] = None
    launchpad_collapsed: Optional[Dict[str, bool]] = None

    @field_validator("theme")
    @classmethod
    def _theme_id(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not THEME_ID_RE.match(value):
            raise ValueError("theme must be a theme id like 'claude' or 'matrix'")
        return value

    @field_validator("audio_master_volume")
    @classmethod
    def _volume_range(cls, value: Optional[float]) -> Optional[float]:
        if value is None:
            return None
        if not (MIN_MASTER_VOLUME <= value <= 1.0):
            raise ValueError(
                f"audio_master_volume must be between {MIN_MASTER_VOLUME} and 1.0"
            )
        return value

    @field_validator("launch_last_model")
    @classmethod
    def _model_id(cls, value: Optional[str]) -> Optional[str]:
        # An empty string is the client's own spelling of "no model,
        # plain claude" and must stay expressible.
        if value is None or value == "":
            return value
        if not MODEL_ID_RE.match(value):
            raise ValueError("launch_last_model is not a valid model id")
        return value

    @field_validator("sidebar_density")
    @classmethod
    def _density(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in SIDEBAR_DENSITIES:
            raise ValueError(f"sidebar_density must be one of {list(SIDEBAR_DENSITIES)}")
        return value

    @field_validator("config_editor_collapsed")
    @classmethod
    def _collapsed_paths(cls, value: Optional[Dict[str, bool]]) -> Optional[Dict[str, bool]]:
        if value is None:
            return None
        if len(value) > MAX_COLLAPSED_PATHS:
            raise ValueError(f"at most {MAX_COLLAPSED_PATHS} remembered tree nodes")
        for key in value:
            if not key or len(key) > MAX_KEY_LENGTH * 8:
                raise ValueError("a tree node key must be 1 to 1024 characters")
        return value

    @field_validator("launchpad_collapsed")
    @classmethod
    def _launchpad_sections(cls, value: Optional[Dict[str, bool]]) -> Optional[Dict[str, bool]]:
        if value is None:
            return None
        for key in value:
            if key not in LAUNCHPAD_SECTION_IDS:
                raise ValueError(
                    f"launchpad_collapsed only covers {list(LAUNCHPAD_SECTION_IDS)}"
                )
        return value


def known_fields() -> frozenset:
    """The set of preference names this server validates.

    Inputs: none.
    Output: frozenset[str].
    """
    return frozenset(UiPreferenceValues.model_fields.keys())


def is_secret_name(name: str) -> bool:
    """Would storing under this key put a credential in the block?

    Description: the unknown-field passthrough accepts names this server
      has never seen, so the one thing it must still refuse is a name
      that reads like a credential. Both auth tokens are named outright;
      the shape check covers the next one nobody thought to list.
    Inputs: name (str) - a candidate preference field name.
    Output: bool - True when the name must be refused.
    """
    return name in _SECRET_KEY_NAMES or bool(_SECRET_KEY_SHAPE.search(name))


def empty_block() -> Dict[str, Any]:
    """The block a config with no ``ui_preferences`` key behaves as.

    Inputs: none.
    Output: dict - ``{"schema_version": 1, "revision": 0, "values": {}}``.
      Revision 0 means "nothing has ever been committed", which a client
      can send as its expected revision for a first write.
    """
    return {"schema_version": SCHEMA_VERSION, "revision": 0, "values": {}}


def read_block(config: Dict[str, Any]) -> Dict[str, Any]:
    """Project the stored block out of a whole config document.

    Description: TOLERANT BY DESIGN. A missing block, a block that is not
      an object, a non-integer revision or a ``values`` that is not an
      object all resolve to the empty block rather than raising, because
      this runs on the read path that every hydration and every
      precondition goes through and a hand-edited config must not make
      the app unable to answer at all. What it never does is INVENT a
      value: an unreadable block reads as "nothing set", the same thing
      an absent one reads as, and the client keeps its own defaults.
    Inputs: config (dict) - the whole parsed config.json.
    Output: dict - ``{"schema_version": int, "revision": int, "values":
      dict}``. ``values`` includes any unrecognised fields verbatim.
    """
    block = config.get(UI_PREFERENCES_KEY)
    if not isinstance(block, dict):
        return empty_block()

    revision = block.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        revision = 0

    version = block.get("schema_version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        version = SCHEMA_VERSION

    values = block.get("values")
    if not isinstance(values, dict):
        values = {}

    return {
        "schema_version": version,
        "revision": revision,
        "values": dict(values),
    }


def revision_of(config: Dict[str, Any]) -> int:
    """The committed revision of the block in a config document.

    Inputs: config (dict) - the whole parsed config.json.
    Output: int - 0 when nothing has ever been committed.
    """
    return read_block(config)["revision"]


def validate_changes(changes: Dict[str, Any]) -> Dict[str, Any]:
    """Validate one PARTIAL update and return it normalised.

    Description: known fields go through ``UiPreferenceValues`` so a bad
      value can never reach disk. Unknown fields are KEPT - a newer
      client's preference must survive an older server - but bounded:
      capped in count, in key length and in serialized size, and refused
      outright if the name reads like a credential. ``None`` is a legal
      value for a known field and means "unset this", which is how a
      client returns a preference to its own default rather than pinning
      one the user never chose.
    Inputs: changes (dict) - field name to new value, ONLY the fields
      the user actually changed.
    Output: dict - the same mapping with known fields normalised (a
      pydantic sub-model dumped back to plain JSON types).
    Raises:
      ValueError: a field failed validation, a name is a credential, or
        a bound was exceeded. The message is a plain sentence a UI can
        show; it never quotes a refused value.

    Example:
        validate_changes({"sidebar_density": "compact"})
        -> {"sidebar_density": "compact"}
    """
    if not isinstance(changes, dict):
        raise ValueError("preferences must be sent as an object of field names")
    if not changes:
        raise ValueError("no preference fields were sent")

    known = known_fields()
    typed: Dict[str, Any] = {}
    unknown: Dict[str, Any] = {}

    for name, value in changes.items():
        if not isinstance(name, str) or not name:
            raise ValueError("a preference name must be a non-empty string")
        if is_secret_name(name):
            raise ValueError("that preference name is reserved and cannot be stored")
        if name in known:
            typed[name] = value
        else:
            if len(name) > MAX_KEY_LENGTH:
                raise ValueError("a preference name may be at most 128 characters")
            unknown[name] = value

    if len(unknown) > MAX_UNKNOWN_FIELDS:
        raise ValueError(f"at most {MAX_UNKNOWN_FIELDS} unrecognised preferences at once")

    normalised: Dict[str, Any] = {}
    if typed:
        # Validate ONLY what was sent. Feeding the whole model would make
        # every absent field explicitly None, turning a partial update
        # into the whole-snapshot overwrite this endpoint exists to stop.
        model = UiPreferenceValues(**typed)
        dumped = model.model_dump(mode="json")
        for name in typed:
            normalised[name] = dumped[name]

    for name, value in unknown.items():
        _refuse_oversized_unknown(name, value)
        normalised[name] = value

    return normalised


def _refuse_oversized_unknown(name: str, value: Any) -> None:
    """Bound one unrecognised preference value.

    Description: preserving what we do not understand is a data-loss
      guarantee, not an invitation to use config.json as storage, so the
      value has to be JSON-serialisable and small. Measured by its own
      serialisation rather than by a type check, because the shape of a
      field this server has never seen is by definition unknown.
    Inputs: name (str); value (Any).
    Output: None.
    Raises: ValueError - not serialisable, or over
      ``MAX_UNKNOWN_VALUE_BYTES``.
    """
    import json

    try:
        encoded = json.dumps(value)
    except (TypeError, ValueError):
        raise ValueError(f"preference '{name}' is not a storable value")
    if len(encoded.encode("utf-8")) > MAX_UNKNOWN_VALUE_BYTES:
        raise ValueError(f"preference '{name}' is too large to store")


def apply_changes(
    config: Dict[str, Any], changes: Dict[str, Any]
) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    """Merge validated changes into a config document's block.

    Description: PURE. Returns a new document rather than mutating the
      one it was given, so the caller inside the serialization boundary
      can decide not to write. A field set to ``None`` is REMOVED from
      ``values`` (the client is returning it to its own default);
      everything else is overwritten. Unrecognised fields already in
      ``values`` are carried straight through. The revision is bumped
      ONLY when something actually changed, so a no-op PATCH does not
      invalidate every other client's cached revision and start a round
      of pointless refreshes.
    Inputs:
      config (dict) - the whole parsed config.json, freshly read.
      changes (dict) - output of ``validate_changes``.
    Output: (new_config, new_block, moved) - the whole new document, the
      block as it now reads, and the fields that ACTUALLY MOVED mapped to
      their new value (``None`` for one that was removed). An empty
      ``moved`` means nothing changed, and in that case the document and
      the block are returned unmodified. ``moved`` is what a
      ``preferences.changed`` event carries: the fields that moved, never
      the fields that were sent, so re-sending a value nobody changed
      tells nobody anything.

    Example:
        new_config, block, moved = apply_changes(config, {"theme": "matrix"})
    """
    block = read_block(config)
    values = dict(block["values"])
    moved: Dict[str, Any] = {}

    for name, value in changes.items():
        if value is None:
            if name in values:
                values.pop(name)
                moved[name] = None
            continue
        if values.get(name, _MISSING) != value:
            values[name] = value
            moved[name] = value

    if not moved:
        return config, block, {}

    new_block = {
        "schema_version": SCHEMA_VERSION,
        "revision": block["revision"] + 1,
        "values": values,
    }
    new_config = dict(config)
    new_config[UI_PREFERENCES_KEY] = new_block
    return new_config, new_block, moved


class _Missing:
    """Sentinel so a stored ``None`` is distinguishable from an absent key."""

    def __repr__(self) -> str:  # pragma: no cover - debug aid only
        return "<missing>"


_MISSING = _Missing()
