"""One browser's settings, offered to the server once, with a preview.

THE PREVIEW AND THE IMPORT ARE THE SAME PLAN. ``build_plan`` is called
by both endpoints and ``changes_from`` derives the write from its output,
so the preview cannot describe one thing and the commit perform another.
A preview that lies is worse than no preview: it is a safety control that
tells the user they are safe. That is the one property
``tests/test_settings_import.py`` is built around - it previews, commits,
and asserts the committed values are exactly what the preview named.

THE ALLOWLIST IS A PROJECTION, NOT A SECOND LIST. It is
``ui_preferences.known_fields()`` minus ``REFUSED_FIELDS``, so a field
added to the preference block is importable the day it lands and nobody
has to remember a second place. The two auth tokens never appear here
because they are not preference fields at all, which is a stronger
guarantee than filtering them out: there is no code path on which they
could be named.

ONE FIELD IS REFUSED DESPITE BEING A PREFERENCE, AND THAT IS THE
INTERESTING PART. ``theme_script_consent`` became a shared preference in
#45, which makes it a known field, which would otherwise make it
importable. It must not be. A browser's local record of "I allowed this
theme's script" is the pre-#45 ``cloude.themeJsAllowlist`` shape: it
names a theme id and no digest, so importing it would mint exactly the
unbounded standing grant #45 exists to make unexpressible. The issue's
own rule says it plainly - "never infer theme-script approval from a
theme selection" - and this is the same rule one step further: never
carry a theme-script approval at all. Refusing by NAME here rather than
by hoping nobody adds it to a collector is what makes that true of any
client, including one written later.

SERVER VALUES WIN BY DEFAULT, AND A CONFLICT IS A NAMED OUTCOME. A field
the server already holds is KEPT unless the user selected that specific
field in the preview. There is no "import everything" that quietly wins:
the selection is per field, and a field not in it is reported as
``CONFLICT_KEPT`` rather than dropped silently, so the preview can show
the user both values and which one is about to survive.

THE MARKER IS THE DEFENCE AGAINST A STALE BROWSER. Once an install has
been imported, ``ALREADY_IMPORTED`` is the answer to every later offer.
The failure this prevents is the reason the whole flow is explicit: a
machine that has not been opened in three months connects, uploads its
snapshot, and silently reverts every setting changed since. A marker on
the INSTALL rather than in each browser is what makes one import
one-time across all of them.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from src.core import ui_preferences

IMPORT_MARKER_KEY = "ui_preferences_import"
"""The top-level config.json key recording that this install has been
imported. A sibling of ``ui_preferences`` rather than a field inside it,
because it describes a one-off migration event and not a preference; a
client hydrating preferences has no business reading it and no reason to
round-trip it."""

MARKER_SCHEMA_VERSION = 1

REFUSED_FIELDS = frozenset({"theme_script_consent"})
"""Preference fields this flow will never carry. See the module
docstring: the local shape of a script consent names no digest, so
importing one would mint an unbounded grant."""

# Per-field outcomes. Every field in a plan carries exactly one.
IMPORTED = "imported"
"""The server held nothing and the candidate will be written."""

IDENTICAL = "identical"
"""The server already holds this exact value. Nothing to write, and
deliberately reported rather than hidden, so the preview's field count
matches what the user can see in their browser."""

CONFLICT_KEPT = "conflict_kept"
"""The server holds a DIFFERENT value and the user did not select this
field. The server's value stands and nothing is written."""

CONFLICT_OVERRIDDEN = "conflict_overridden"
"""The server holds a different value and the user selected this field
in the preview. The candidate will be written."""

REJECTED_INVALID = "rejected_invalid"
"""The candidate failed the preference block's own validation. Nothing
is written for it, and the rest of the plan still stands: one bad value
in a browser must not block the import of the good ones."""

REFUSED = "refused"
"""The field is not importable: not a preference this server knows, or
on ``REFUSED_FIELDS``."""

WRITING_OUTCOMES = frozenset({IMPORTED, CONFLICT_OVERRIDDEN})
"""The only two outcomes that put anything on disk. A caller asks this
set rather than listing the refusals, which can grow."""

# Whole-request outcomes.
COMMITTED = "committed"
UNCHANGED = "unchanged"
ALREADY_IMPORTED = "already_imported"
STALE_REVISION = "stale_revision"


class FieldPlan:
    """What the import will do to one field, and why.

    Attributes:
      field (str): the preference name.
      outcome (str): one of the per-field outcomes above.
      candidate (Any): the value this browser offered, normalised when it
        validated. ``None`` for a refused or unparseable one.
      current (Any): the value the server holds, or ``None`` when it
        holds nothing. ``None`` is genuinely "nothing set" here, because
        the preference block removes a field rather than storing null.
      detail (str|None): a plain sentence for a refusal, safe to show.
    """

    __slots__ = ("field", "outcome", "candidate", "current", "detail")

    def __init__(
        self,
        field: str,
        outcome: str,
        candidate: Any = None,
        current: Any = None,
        detail: Optional[str] = None,
    ) -> None:
        self.field = field
        self.outcome = outcome
        self.candidate = candidate
        self.current = current
        self.detail = detail

    @property
    def writes(self) -> bool:
        """Whether this field ends up on disk.

        Inputs: none.
        Output: bool.
        """
        return self.outcome in WRITING_OUTCOMES

    def as_payload(self) -> Dict[str, Any]:
        """The field plan as plain JSON types, for the preview response.

        Inputs: none.
        Output: dict.
        """
        body: Dict[str, Any] = {
            "field": self.field,
            "outcome": self.outcome,
            "candidate": self.candidate,
            "current": self.current,
            "writes": self.writes,
        }
        if self.detail:
            body["detail"] = self.detail
        return body

    def __repr__(self) -> str:  # pragma: no cover - debug aid only
        return f"<FieldPlan {self.field} {self.outcome}>"


def importable_fields() -> frozenset:
    """Every preference field this flow may carry.

    Description: derived from the preference block rather than listed, so
      a field added there is importable without a second edit here, and
      the refused set is the only thing this module asserts on its own.
    Inputs: none.
    Output: frozenset[str].

    Example:
        'theme' in importable_fields()  -> True
        'theme_script_consent' in importable_fields()  -> False
    """
    return frozenset(ui_preferences.known_fields()) - REFUSED_FIELDS


def build_plan(
    candidates: Dict[str, Any],
    server_values: Dict[str, Any],
    selections: Optional[Sequence[str]] = None,
) -> List[FieldPlan]:
    """Decide, field by field, what an import would do.

    Description: PURE, and the single source of both the preview and the
      write. Fields are planned in a stable sorted order so the preview
      renders the same way twice and a test can compare whole plans.
      Each candidate is validated ON ITS OWN through
      ``ui_preferences.validate_changes``, so one unusable value in a
      browser refuses only itself.
    Inputs:
      candidates (dict) - field name to the value this browser offered.
      server_values (dict) - the preference block's current ``values``.
      selections (sequence[str]|None) - the fields the user explicitly
        chose to overwrite the server with. Anything not named here loses
        to an existing server value.
    Output: list[FieldPlan], one per candidate field, sorted by name.

    Example:
        build_plan({"theme": "matrix"}, {}, None)[0].outcome
        -> 'imported'
    """
    chosen = set(selections or ())
    allowed = importable_fields()
    held = server_values if isinstance(server_values, dict) else {}
    plans: List[FieldPlan] = []

    for field in sorted(candidates.keys()):
        raw = candidates[field]

        if field not in allowed:
            plans.append(
                FieldPlan(
                    field,
                    REFUSED,
                    detail=_refusal_sentence(field),
                )
            )
            continue

        try:
            normalised = ui_preferences.validate_changes({field: raw})[field]
        except ValueError as exc:
            plans.append(
                FieldPlan(field, REJECTED_INVALID, current=held.get(field), detail=str(exc))
            )
            continue

        if normalised is None:
            # The client offered "unset this", which is not something an
            # import has any business doing: it would delete a value the
            # server holds on the strength of a browser having none.
            plans.append(
                FieldPlan(
                    field,
                    REJECTED_INVALID,
                    current=held.get(field),
                    detail="an import can add or replace a setting, never clear one",
                )
            )
            continue

        if field not in held:
            plans.append(FieldPlan(field, IMPORTED, candidate=normalised, current=None))
            continue

        current = held[field]
        if current == normalised:
            plans.append(
                FieldPlan(field, IDENTICAL, candidate=normalised, current=current)
            )
            continue

        outcome = CONFLICT_OVERRIDDEN if field in chosen else CONFLICT_KEPT
        plans.append(
            FieldPlan(field, outcome, candidate=normalised, current=current)
        )

    return plans


def _refusal_sentence(field: str) -> str:
    """Why one field cannot be imported, in a sentence a UI can show.

    Inputs: field (str).
    Output: str.
    """
    if field in REFUSED_FIELDS:
        return (
            "a theme script approval is never imported; this browser's record "
            "names a theme but not the script it approved, so you are asked "
            "again the next time that theme is applied"
        )
    return "this server does not recognise that setting"


def changes_from(plans: Iterable[FieldPlan]) -> Dict[str, Any]:
    """The exact partial update the plan describes.

    Description: THE ONE DERIVATION. The commit writes this and the
      preview renders the plan it came from, so they cannot disagree
      about what is about to happen.
    Inputs: plans (iterable[FieldPlan]).
    Output: dict - field name to value, empty when the plan writes
      nothing.

    Example:
        changes_from(build_plan({"theme": "matrix"}, {}))
        -> {"theme": "matrix"}
    """
    return {plan.field: plan.candidate for plan in plans if plan.writes}


def summarise(plans: Sequence[FieldPlan]) -> Dict[str, int]:
    """Count the plan by outcome, for a one-line summary above the list.

    Inputs: plans (sequence[FieldPlan]).
    Output: dict - outcome name to count, including zeros so a caller
      never has to guess whether a missing key means none or means the
      key was renamed.

    Example:
        summarise(build_plan({"theme": "matrix"}, {}))["imported"] -> 1
    """
    counts = {
        IMPORTED: 0,
        IDENTICAL: 0,
        CONFLICT_KEPT: 0,
        CONFLICT_OVERRIDDEN: 0,
        REJECTED_INVALID: 0,
        REFUSED: 0,
    }
    for plan in plans:
        if plan.outcome in counts:
            counts[plan.outcome] += 1
    return counts


# ---- the completion marker -------------------------------------------


def read_marker(config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The import marker stored in a config document, if there is one.

    Description: TOLERANT like ``ui_preferences.read_block``. A marker
      that is not an object reads as absent, because the only thing this
      value gates is whether to OFFER an import, and offering one to a
      user whose marker got mangled is recoverable while refusing one
      forever is not.
    Inputs: config (dict) - the whole parsed config.json.
    Output: dict|None.
    """
    marker = config.get(IMPORT_MARKER_KEY)
    if not isinstance(marker, dict):
        return None
    if not marker.get("completed_at"):
        return None
    return marker


def is_completed(config: Dict[str, Any]) -> bool:
    """Has this install already been imported?

    Inputs: config (dict).
    Output: bool.
    """
    return read_marker(config) is not None


def build_marker(fields: Sequence[str], now: Optional[datetime] = None) -> Dict[str, Any]:
    """The marker to write alongside a successful import.

    Description: records WHICH fields the import actually wrote, not
      which were offered, so a later reader can tell an import that moved
      settings from one that found everything already in place. Both are
      completions and both close the offer.
    Inputs:
      fields (sequence[str]) - the fields written.
      now (datetime|None) - injectable for tests; defaults to UTC now.
    Output: dict.

    Example:
        build_marker(["theme"])["fields"] -> ['theme']
    """
    stamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return {
        "schema_version": MARKER_SCHEMA_VERSION,
        "completed_at": stamp.isoformat().replace("+00:00", "Z"),
        "fields": sorted(fields),
    }


def apply_import(
    config: Dict[str, Any],
    changes: Dict[str, Any],
    now: Optional[datetime] = None,
) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    """Merge an import's changes AND its marker into one new document.

    Description: PURE, and ONE document. The values and the marker move
      together or neither moves: a commit that wrote the settings but not
      the marker would leave the install offering the import again, and
      one that wrote the marker but not the settings would close the
      offer having changed nothing. An import that writes NO values still
      writes the marker, because "everything here was already on the
      server" is a completed import and re-offering it helps nobody.
    Inputs:
      config (dict) - the whole parsed config.json, freshly read.
      changes (dict) - the output of ``changes_from``.
      now (datetime|None) - injectable clock.
    Output: (new_config, new_block, moved) - the whole new document, the
      preference block as it now reads, and the fields that actually
      moved.

    Example:
        new_config, block, moved = apply_import(config, {"theme": "matrix"})
    """
    if changes:
        new_config, block, moved = ui_preferences.apply_changes(config, changes)
    else:
        new_config, block, moved = dict(config), ui_preferences.read_block(config), {}
    new_config = dict(new_config)
    new_config[IMPORT_MARKER_KEY] = build_marker(list(moved.keys()), now=now)
    return new_config, block, moved
