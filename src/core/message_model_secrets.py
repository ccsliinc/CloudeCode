"""Detecting credential material in a transcript record, without ever
handling the credential.

WHY THIS EXISTS AND WHY IT DOES NOT REDACT. The owner has a live
1Password service-account token sitting in 308 message rows across 117
sessions, and has decided - on the record - not to rotate it until this
project ends. Redacting on the way in was rejected outright: the whole
point of the message model is that a stored record reproduces its
original bytes exactly, and a redacted record does not. So a record
carrying a credential is stored byte-exactly, and FLAGGED. The flag is
what makes the set enumerable, and an enumerable set is what turns the
eventual rotation from a hunt into a clean cut.

THE VALUE IS NEVER RETURNED, NEVER LOGGED, NEVER STORED. A finding
carries the detector's name, where in the text the match sat, and a
sha256 of the matched value - nothing else. There is no code path in this
module that puts a matched substring into a return value, an exception
message, a log line or a repr. The hash is there for one reason: it makes
"these 308 rows all carry the SAME credential" answerable without the
database becoming a second place that credential lives.

A REFERENCE IS NOT A SECRET, AND THAT DISTINCTION HAS ALREADY COST REAL
TIME. ``op://Claude/Paperless/api_token`` is a 1Password REFERENCE - a
pointer, safe to store, safe to commit, and exactly 31 characters, which
is short enough to look like a dead API token. Three separate agents in
this fleet mistook one for a credential on 2026-08-24 and one nearly
rotated a key that was never wrong. :data:`REFERENCE_PREFIXES` keeps that
class out of the findings, so the flagged set stays small enough to be
worth reading.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import List, Tuple

#: Name of the detector that finds a 1Password service-account token. The
#: real token is ``ops_`` followed by a long base64 payload holding the
#: SRP secret, the MUK and the account key - it carries no timestamp of
#: any kind, so nothing about it can be dated from the value itself.
DETECTOR_OP_SERVICE_ACCOUNT: str = "op_service_account_token"

#: Name of the detector that finds a high-entropy value assigned to a
#: name that says it is a credential.
DETECTOR_HIGH_ENTROPY_ASSIGNMENT: str = "high_entropy_assignment"

ALL_DETECTORS: Tuple[str, ...] = (
    DETECTOR_OP_SERVICE_ACCOUNT, DETECTOR_HIGH_ENTROPY_ASSIGNMENT,
)

#: Prefixes that mark a value as a POINTER at a secret rather than the
#: secret. Matching one of these excludes the value from every detector.
REFERENCE_PREFIXES: Tuple[str, ...] = ("op://", "vault://", "keychain://")

#: An ``ops_`` token, requiring enough payload that a mention of the
#: literal string ``ops_`` in prose cannot match.
_OP_TOKEN_RE = re.compile(r"ops_[A-Za-z0-9+/=_-]{40,}")

#: NAME = VALUE where the name says "credential". The name must END in
#: one of the credential words (or be one), so ``KEYBOARD_LAYOUT`` and
#: ``PASSWORD_PROMPT_TEXT`` do not match while ``API_KEY``,
#: ``anthropic_api_key`` and ``"secret"`` do. The value is taken up to
#: the first quote, whitespace, comma or brace, so a JSON string value
#: and a shell assignment are both covered by one pattern.
_ASSIGNMENT_RE = re.compile(
    r"""(?ix)
    [\"']?
    (?P<name>[A-Za-z0-9_.\-]*
             (?:token|secret|key|password|passwd|api_key|apikey))
    [\"']?
    \s*[:=]\s*
    [\"']?
    (?P<value>[A-Za-z0-9+/=_\-.]{20,})
    """
)

#: Minimum Shannon entropy, in bits per character, for an assigned value
#: to count as credential material. Measured against the two populations
#: that matter: a base64/hex credential sits comfortably above 4.0, while
#: the false positives this threshold exists to reject - a repeated
#: placeholder, a dotted module path, a long snake_case identifier - sit
#: below it. 3.5 is deliberately conservative: this flag exists to make a
#: set enumerable for a human, so an extra row in the list costs a glance
#: and a missed row costs a credential.
MIN_ENTROPY_BITS_PER_CHAR: float = 3.5


def shannon_entropy(text: str) -> float:
    """Shannon entropy of a string, in bits per character.

    Description: the standard measure over the string's own character
      distribution. Returns 0.0 for the empty string rather than raising,
      because an empty candidate is simply not credential material.
    Inputs: text (str).
    Output: float - bits per character, 0.0 for an empty string.
    Example: round(shannon_entropy("aaaa"), 3) -> 0.0
    """
    if not text:
        return 0.0
    counts = Counter(text)
    total = len(text)
    return -sum(
        (n / total) * math.log2(n / total) for n in counts.values()
    )


def _is_reference(value: str) -> bool:
    """Whether a value is a pointer at a secret rather than the secret.

    Description: see REFERENCE_PREFIXES and this module's docstring for
      why this distinction is load-bearing rather than a nicety.
    Inputs: value (str).
    Output: bool.
    Example: _is_reference("op://Claude/Gogs/api_token") -> True
    """
    return any(value.startswith(p) for p in REFERENCE_PREFIXES)


@dataclass(frozen=True)
class SecretFinding:
    """One credential match, described without the credential.

    - ``detector``: which detector fired, one of ALL_DETECTORS.
    - ``offset`` / ``length``: where the match sat in the searched text.
    - ``value_sha256``: sha256 of the matched value, so two records
      carrying the same credential are recognisable as one credential.

    There is deliberately no field for the value. Adding one would make
    every caller, log line and test fixture a place the credential can
    escape to.
    """

    detector: str
    offset: int
    length: int
    value_sha256: str

    def __post_init__(self) -> None:
        if self.detector not in ALL_DETECTORS:
            raise ValueError(f"unknown detector: {self.detector!r}")
        if self.length <= 0:
            raise ValueError("SecretFinding.length must be positive")


def _finding(detector: str, value: str, offset: int) -> SecretFinding:
    """Build a SecretFinding from a matched value without retaining it.

    Description: the single construction site, so hashing can never be
      forgotten at one call site and remembered at another.
    Inputs: detector (str), value (str - the matched text, used only to
      hash and measure), offset (int).
    Output: SecretFinding.
    Example: _finding(DETECTOR_OP_SERVICE_ACCOUNT, "ops_" + "a" * 40, 0)
      .length -> 44
    """
    return SecretFinding(
        detector=detector,
        offset=offset,
        length=len(value),
        value_sha256=hashlib.sha256(value.encode("utf-8")).hexdigest(),
    )


def scan_text(text: str) -> List[SecretFinding]:
    """Find credential material in one block of text.

    Description: runs both detectors and returns their findings ordered
      by offset. An ``ops_`` token is reported by the op detector only,
      even when the assignment detector would also have matched it, so
      one credential produces one finding rather than two - a count that
      double-reports is a count nobody can act on.
    Inputs: text (str) - the text to search, typically one record's
      rendered body JSON.
    Output: list[SecretFinding], ordered by offset. Empty when nothing
      matched, which is a real negative result and not a "could not
      determine" - the search ran over the whole string.
    Example: len(scan_text("token=" + "op://Claude/x/y")) -> 0
    """
    findings: List[SecretFinding] = []
    claimed: List[Tuple[int, int]] = []

    for match in _OP_TOKEN_RE.finditer(text):
        value = match.group(0)
        findings.append(
            _finding(DETECTOR_OP_SERVICE_ACCOUNT, value, match.start())
        )
        claimed.append((match.start(), match.end()))

    for match in _ASSIGNMENT_RE.finditer(text):
        value = match.group("value")
        start = match.start("value")
        end = match.end("value")
        if any(start < c_end and c_start < end for c_start, c_end in claimed):
            continue
        if _is_reference(value):
            continue
        if shannon_entropy(value) < MIN_ENTROPY_BITS_PER_CHAR:
            continue
        findings.append(
            _finding(DETECTOR_HIGH_ENTROPY_ASSIGNMENT, value, start)
        )

    findings.sort(key=lambda f: f.offset)
    return findings
