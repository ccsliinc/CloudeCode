"""Whether a theme's ``effects.js`` may run, as one ladder, with no I/O.

A theme can ship a JavaScript module that runs in the page. #45 made the
consent decision a SHARED setting so a ``never`` set on one device binds
on another, which is the half of sharing that can only ever reduce what
executes. The half that can only ever increase it - an ``always`` - is
the half that needed an argument, and the argument is in
``theme_script_digest``: a grant names the BYTES it was given for, so it
cannot silently cover a file edited afterwards.

SIX OUTCOMES, ONE OF WHICH RUNS. That asymmetry is the design. Every way
of not knowing resolves to a refusal, so the failure mode of this module
is a theme that looks plainer than it should, never a script that ran on
evidence nobody checked. A test that only proves the consented path works
would pass against a gate that never refuses, which is why the refusing
rungs are the ones with the controls on them.

THE ORDER OF THE RUNGS IS THE WHOLE CLAIM, and it is:

  1. The manifest declares no script. Nothing to decide.
  2. A ``never`` is on record. DENY WINS OVER EVERYTHING, including the
     bundled-theme bypass below and including a newer ``always``. A
     restriction is never overridden by a grant, in either direction,
     whichever was written last: the whole reason sharing a restriction
     is safe is that it cannot be talked out of.
  3. The consent record could not be read. A grant that cannot be checked
     against the current record cannot be shown not to be superseded, so
     it does not run. See "why this fails closed" below.
  4. The theme is BUNDLED. It shipped in this repo, so it is our code
     rather than third-party content, and an attacker able to ship a
     malicious bundled ``effects.js`` can equally ship a malicious
     ``registry.js`` - a modal in front of our own code is friction with
     no security gain. This is the rung that was already shipped and is
     restated here rather than reversed.
  5. No digest could be taken for a user theme's declared script. The
     bytes cannot be named, so no grant can be matched to them.
  6. A grant exists and names DIFFERENT bytes. The script changed after
     it was approved, which is a new script, so it is asked about again.
  7. A grant exists and names THESE bytes. Run.
  8. Nothing on record. Ask.

WHY THIS FAILS CLOSED ON AN UNREADABLE RECORD. The plan #45 implements
says "a cached approval, pending prompt, or in-flight load cannot outrank
a newer global Never". A client that could not read the record cannot
know whether a newer ``never`` exists, so honouring a cached grant there
would be exactly that outranking. The cost of refusing is a theme that
renders without its animation and says so in the log; the cost of
allowing is running a script the user may have revoked on another device.

``ONCE`` NEVER APPEARS IN A STORED RECORD. It is a decision about one
sitting at one machine, so it is held in the running page and never
written and never sent. ``validate_consent_map`` refuses the word
outright, which means the rule is enforced where the data enters rather
than remembered at each of the places that could write it.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Mapping, Optional, Tuple

DECISION_ALWAYS = "always"
DECISION_NEVER = "never"
DECISION_ONCE = "once"
"""Spelled here so the refusal below can name it, NOT because it is
storable. A ``once`` is runtime state in one browser tab."""

PERSISTABLE_DECISIONS = (DECISION_ALWAYS, DECISION_NEVER)

SOURCE_BUILTIN = "builtin"
SOURCE_USER = "user"

RUN = "run"
"""The only outcome that executes anything."""

SKIP_NO_SCRIPT = "skip_no_script"
SKIP_DENIED = "skip_denied"
SKIP_UNVERIFIABLE = "skip_unverifiable"
PROMPT = "prompt"
PROMPT_CHANGED = "prompt_changed"

RUNNING_OUTCOMES = frozenset({RUN})
"""One entry, on purpose. A caller asks this set whether to execute
rather than comparing against a list of refusals that a new rung could be
added to without anyone noticing."""

RUNG_NO_SCRIPT = "no_script"
RUNG_DENIED = "denied"
RUNG_RECORD_UNREADABLE = "record_unreadable"
RUNG_BUILTIN = "builtin"
RUNG_DIGEST_UNAVAILABLE = "digest_unavailable"
RUNG_DIGEST_MISMATCH = "digest_mismatch"
RUNG_GRANTED = "granted"
RUNG_NO_RECORD = "no_record"

DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
THEME_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

MAX_CONSENT_ENTRIES = 256
"""A record per theme the user has ever answered for. Bounded so the
preference block cannot be grown without limit by a client looping over
invented theme ids."""


class ConsentDecision:
    """What the ladder answered, and which rung answered it.

    Attributes:
      outcome (str): one of ``RUN``, ``SKIP_NO_SCRIPT``, ``SKIP_DENIED``,
        ``SKIP_UNVERIFIABLE``, ``PROMPT``, ``PROMPT_CHANGED``. Only
        ``RUN`` permits execution.
      rung (str): which rule answered, so a log line and a future UI can
        tell "the user said no" from "we could not check", which are two
        different facts that both stop a script.
      digest (str|None): the digest the decision was taken against, which
        is what a resulting ``always`` must be recorded with. ``None``
        when there was nothing to measure.
    """

    __slots__ = ("outcome", "rung", "digest")

    def __init__(self, outcome: str, rung: str, digest: Optional[str] = None) -> None:
        self.outcome = outcome
        self.rung = rung
        self.digest = digest

    @property
    def may_run(self) -> bool:
        """Whether the caller may execute the script.

        Inputs: none.
        Output: bool.
        """
        return self.outcome in RUNNING_OUTCOMES

    def as_payload(self) -> Dict[str, Any]:
        """The decision as plain JSON types, for a response or a test.

        Inputs: none.
        Output: dict.
        """
        return {"outcome": self.outcome, "rung": self.rung, "digest": self.digest}

    def __repr__(self) -> str:  # pragma: no cover - debug aid only
        return f"<ConsentDecision {self.outcome} via {self.rung}>"


def decide(
    *,
    declares_script: bool,
    source: str,
    served_digest: Optional[str],
    record: Optional[Mapping[str, Any]],
    record_readable: bool = True,
) -> ConsentDecision:
    """Answer whether one theme's ``effects.js`` may run right now.

    Description: PURE, and the only place the ordering in this module's
      docstring exists. Both the server's own check and the client's gate
      resolve through this shape, so the two cannot disagree about what a
      record means.
    Inputs:
      declares_script (bool) - whether the manifest named an ``effects``
        file at all.
      source (str) - ``"builtin"`` or ``"user"``, as the server stamped
        it. Anything else is treated as a user theme, because an
        unrecognised provenance is not a reason to trust something more.
      served_digest (str|None) - the digest of the bytes about to be
        fetched, or None when it could not be taken.
      record (Mapping|None) - this theme's stored consent entry, shaped
        ``{"decision": "always", "digest": "<hex>"}``, or None when the
        user has never answered for it.
      record_readable (bool) - whether the consent store could be read at
        all. False means "we do not know what is on record", which is a
        refusal and not an absence.
    Output: ConsentDecision.

    Example:
        decide(declares_script=True, source="user", served_digest=d,
               record={"decision": "always", "digest": d}).may_run
        -> True
    """
    if not declares_script:
        return ConsentDecision(SKIP_NO_SCRIPT, RUNG_NO_SCRIPT, None)

    entry = record if isinstance(record, Mapping) else None
    decision = entry.get("decision") if entry else None

    # Rung 2. A denial outranks every rung below it, the bundled bypass
    # included. This is checked before readability because a denial we
    # were able to read is a fact, and nothing further down can improve
    # on it.
    if decision == DECISION_NEVER:
        return ConsentDecision(SKIP_DENIED, RUNG_DENIED, served_digest)

    # Rung 3. We could not read the record, so we cannot show that no
    # newer denial exists.
    if not record_readable:
        return ConsentDecision(SKIP_UNVERIFIABLE, RUNG_RECORD_UNREADABLE, served_digest)

    # Rung 4. Our own code.
    if source == SOURCE_BUILTIN:
        return ConsentDecision(RUN, RUNG_BUILTIN, served_digest)

    # Rung 5. A user theme whose bytes we could not name.
    if not served_digest or not DIGEST_RE.match(served_digest):
        return ConsentDecision(SKIP_UNVERIFIABLE, RUNG_DIGEST_UNAVAILABLE, None)

    if decision == DECISION_ALWAYS:
        granted_digest = entry.get("digest") if entry else None
        # Rung 6/7. A grant covers the bytes it named and no others.
        if isinstance(granted_digest, str) and granted_digest == served_digest:
            return ConsentDecision(RUN, RUNG_GRANTED, served_digest)
        return ConsentDecision(PROMPT_CHANGED, RUNG_DIGEST_MISMATCH, served_digest)

    # Rung 8.
    return ConsentDecision(PROMPT, RUNG_NO_RECORD, served_digest)


def record_for(decision: str, digest: Optional[str]) -> Optional[Dict[str, Any]]:
    """The entry to store for one answered prompt, or None to store nothing.

    Description: ``once`` answers None, which is how "do not persist this"
      is expressed as a value rather than as a rule each caller has to
      remember. An ``always`` with no digest also answers None: a grant
      that names no bytes is unbounded, and refusing to build one here
      means no caller can accidentally write one.
    Inputs:
      decision (str) - ``"always"``, ``"never"`` or ``"once"``.
      digest (str|None) - the digest the user was shown this for.
    Output: dict|None - the entry, or None when nothing should be stored.

    Example:
        record_for("never", None) -> {"decision": "never"}
        record_for("once", "ab..") -> None
    """
    if decision == DECISION_NEVER:
        # A denial is about the theme, not about one version of its
        # script, so it deliberately carries no digest - storing one
        # would invite a later reader to scope the refusal to bytes.
        return {"decision": DECISION_NEVER}
    if decision == DECISION_ALWAYS:
        if isinstance(digest, str) and DIGEST_RE.match(digest):
            return {"decision": DECISION_ALWAYS, "digest": digest}
        return None
    return None


def validate_consent_map(value: Any) -> Dict[str, Dict[str, Any]]:
    """Validate the whole stored map, returning it normalised.

    Description: this is what keeps the rules above true of anything on
      disk. An ``always`` without a well-formed digest is REFUSED rather
      than downgraded, because a silently-dropped digest is the unbounded
      grant this design exists to make unexpressible, and ``once`` is
      refused by name.
    Inputs: value (Any) - the candidate map, theme id to entry.
    Output: dict - the same map, normalised (a ``never`` keeps no
      digest).
    Raises: ValueError - a plain sentence naming what is wrong. It never
      quotes a digest or an id back, matching the rest of the preference
      validation.

    Example:
        validate_consent_map({"matrix": {"decision": "never"}})
        -> {"matrix": {"decision": "never"}}
    """
    if not isinstance(value, dict):
        raise ValueError("theme script consent must be an object of theme ids")
    if len(value) > MAX_CONSENT_ENTRIES:
        raise ValueError(
            f"at most {MAX_CONSENT_ENTRIES} theme script consent entries"
        )

    out: Dict[str, Dict[str, Any]] = {}
    for theme_id, entry in value.items():
        if not isinstance(theme_id, str) or not THEME_ID_RE.match(theme_id):
            raise ValueError("a theme script consent key must be a theme id")
        if not isinstance(entry, dict):
            raise ValueError("each theme script consent entry must be an object")

        decision = entry.get("decision")
        if decision == DECISION_ONCE:
            raise ValueError(
                "'allow once' is a temporary choice and is never stored"
            )
        if decision not in PERSISTABLE_DECISIONS:
            raise ValueError(
                f"a theme script consent decision must be one of "
                f"{list(PERSISTABLE_DECISIONS)}"
            )

        digest = entry.get("digest")
        if decision == DECISION_ALWAYS:
            if not isinstance(digest, str) or not DIGEST_RE.match(digest):
                raise ValueError(
                    "allowing a theme script requires the digest of the script "
                    "that was approved"
                )
            out[theme_id] = {"decision": DECISION_ALWAYS, "digest": digest}
        else:
            out[theme_id] = {"decision": DECISION_NEVER}

    return out


def revocations_between(
    before: Optional[Mapping[str, Any]], after: Optional[Mapping[str, Any]]
) -> Tuple[str, ...]:
    """Which themes moved INTO a denial between two versions of the map.

    Description: a client applying a remote change needs to know which
      running scripts must be torn down, and that is strictly the set
      that now reads ``never`` and did not before. A theme that merely
      lost its grant is not a revocation to tear down: it will simply be
      asked about next time it is applied.
    Inputs: before (Mapping|None); after (Mapping|None).
    Output: tuple[str, ...] - theme ids, sorted, so the result is stable
      to compare in a test.

    Example:
        revocations_between({}, {"matrix": {"decision": "never"}})
        -> ('matrix',)
    """
    prior = before if isinstance(before, Mapping) else {}
    current = after if isinstance(after, Mapping) else {}
    moved = []
    for theme_id, entry in current.items():
        if not isinstance(entry, Mapping) or entry.get("decision") != DECISION_NEVER:
            continue
        was = prior.get(theme_id)
        if isinstance(was, Mapping) and was.get("decision") == DECISION_NEVER:
            continue
        moved.append(theme_id)
    return tuple(sorted(moved))
