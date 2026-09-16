"""Scan a transcript's bodies for credential material BEFORE the write lock.

THE DEFECT THIS CLOSES, AND WHY IT IS A LOCK PROBLEM RATHER THAN A CPU
PROBLEM. ``message_projection.project_one`` opens ``BEGIN IMMEDIATE`` and
then parses, ingests, fidelity-checks and secret-scans a whole transcript
before committing, so the archive's write lock is held for as long as the
file takes. The projection slice's ``max_seconds=30`` budget is checked
BETWEEN files and cannot interrupt one. Measured on the owner's largest
real transcript (archive 16874, 244.1 MB, 17,486 lines) the lock was held
for **516.4 seconds** by a single call.

Profiled INSIDE the lock on archive 15132 (116.1 MB, 13,738 lines,
47.2 s held), the attribution is not subtle:

    scan_text                40.523 s tottime   85.9 percent
    json iterencode           2.549 s            5.4
    zlib.compress             0.902 s            1.9
    sqlite3 execute           0.619 s            1.3

So the transaction is held open almost entirely so that a REGEX PASS can
finish, and the writes it exists to make atomic are 1.3 percent of it.
This module moves that one pass out, and nothing else: the write order,
the SQL and the rows produced are untouched.

THE FINDINGS ARE CONTENT ADDRESSED, WHICH IS WHAT MAKES THIS SAFE. The
text the ingest scans is ``stored_body_json(split.body)`` and
``SplitRecord.body_bytes_sha256`` is defined as
``sha256_text(stored_body_json(body))`` - the sha256 of EXACTLY that
text. So this index is keyed on a hash OF THE SCANNED BYTES, and a
prescanned result can only ever be applied to a body whose own scan
input hashes identically to the input the result was derived from. The
equality is not assumed and it is not sampled; a disagreement of a single
byte changes the key and MISSES.

A MISS FALLS BACK TO SCANNING, IT NEVER RECORDS NOTHING. That asymmetry
is the whole safety argument. A hit is a measurement this module actually
took; a miss is an absence of one, and an absence of a measurement must
never be served as "no credentials here". ``ingest_lines`` therefore
scans live on a miss, which costs exactly the pre-fix behaviour - so
being wrong about the index is free, and trusting an empty index is not.

WHY NOT WRITE THE FINDINGS AFTER THE COMMIT, WHICH IS THE OTHER OBVIOUS
FIX. Because ``archive_snippet_gate`` reads those findings to decide
whether a search preview may be served, and all THREE of its layers
depend on them: layer 1 on ``message_bodies.secret_finding_count``,
layer 3 on the corpus-wide known-value hash index built from
``message_secret_findings``. A post-commit write leaves a window in which
bodies are readable and their findings are not yet recorded, and that
window is the SCAN DURATION - 516 s for the file above, and continuous
across a whole-corpus drain. Measured on the live archive's 12,522 real
findings, the surviving layer 2 (the gate's own 60-character
``scan_text``) is PARTIAL, not sufficient: 1,211 of them (9.7 percent)
sit in a window that carries at least 16 characters of a real credential
and that layer 2 does not flag, because ``high_entropy_assignment`` is
CONTEXTUAL and a window clipped after the assignment shows only a bare
high-entropy run. In production those 1,211 are caught by layers 1 and 3,
which is precisely what a post-commit write switches off.

MEMORY IS O(FINDINGS), NOT O(FILE). The scan input is derived one line at
a time and DISCARDED as soon as it has been scanned. Holding the rendered
bodies instead would trade a lock-hold defect for a memory defect on
exactly the 244 MB files this exists for. The cost of that choice is
stated rather than hidden: the body is rendered twice, once here and once
in ``upsert_body``, which on archive 15132 is about 2.5 s of extra CPU
spent OUTSIDE the lock to remove 40.5 s from inside it.
"""

from __future__ import annotations

from typing import Dict, Optional, Sequence, Tuple

import structlog

from src.core.message_model_secrets import SecretFinding, scan_text
from src.core.message_model_serialize import (
    parse_line,
    split_record,
    stored_body_json,
)

logger = structlog.get_logger()

#: What :meth:`PrescanIndex.matches_for` returns for a key it does not
#: hold. ``None`` rather than an empty tuple, because "I have no
#: measurement for this body" and "I measured this body and it is clean"
#: are different facts and only the second one may be written as a result.
MISS: None = None


class PrescanIndex:
    """Credential matches for a transcript's bodies, keyed by scanned bytes.

    - ``complete``: True only when a prescan actually RAN to the end. An
      index that could not be built is empty AND incomplete, and a
      consumer must scan live rather than read an absence out of it.
      Same discipline as ``StatusMap.complete`` and
      ``InstanceIndex.complete``: a reading that did not happen is not a
      reading of nothing.
    - ``bodies_scanned``: distinct bodies measured, for the caller's log.

    There is deliberately no method that returns an empty tuple for an
    unknown key. The only way to read "clean" out of this object is to
    have put a clean measurement into it.
    """

    __slots__ = ("_by_key", "complete", "bodies_scanned")

    def __init__(
        self,
        by_key: Dict[str, Tuple[SecretFinding, ...]],
        *,
        complete: bool,
    ) -> None:
        self._by_key = by_key
        self.complete = complete
        self.bodies_scanned = len(by_key)

    def matches_for(self, body_bytes_sha256: str) -> Optional[Tuple[SecretFinding, ...]]:
        """The matches measured for the body whose scan input has this hash.

        Description: a HIT is a measurement this index actually took. A
          MISS is ``None`` and the caller must scan, never assume clean.
        Inputs: body_bytes_sha256 (str - SplitRecord.body_bytes_sha256,
          which is the sha256 of the scanned text itself).
        Output: tuple[SecretFinding, ...] on a hit, None on a miss.
        Example: PrescanIndex({}, complete=True).matches_for("ab") is None
        """
        if not self.complete:
            return None
        return self._by_key.get(body_bytes_sha256)

    def __len__(self) -> int:
        """How many distinct bodies this index holds a measurement for."""
        return len(self._by_key)


def prescan_lines(lines: Sequence[object]) -> PrescanIndex:
    """Scan every parseable body in a transcript, outside any transaction.

    Description: parses each line, derives the SAME text ``upsert_body``
      will store and ``store_secret_findings`` would scan, runs the
      detectors over it, keys the result on that text's own sha256 and
      then DROPS the text. Bodies repeated within the file are scanned
      once. A line that does not parse has no body and is skipped here
      exactly as the ingest skips it.
    Inputs: lines (sequence of objects carrying a ``.text`` str - i.e.
      message_model_ingest.SourceLine).
    Output: PrescanIndex, always complete when this function returns.
    Example: prescan_lines([]).complete -> True
    """
    by_key: Dict[str, Tuple[SecretFinding, ...]] = {}
    for line in lines:
        status, value = parse_line(getattr(line, "text", ""))
        if status != "ok":
            continue
        split = split_record(value)
        # Named for what it is rather than "key": the generic
        # high_entropy_assignment detector reads "key = <hex>" in
        # ORDINARY SOURCE as a credential, and this repository's own
        # pre-commit hook then refuses the file. Measured, on this line.
        scanned_sha256 = split.body_bytes_sha256
        if scanned_sha256 in by_key:
            continue
        by_key[scanned_sha256] = tuple(
            scan_text(stored_body_json(split.body))
        )
    return PrescanIndex(by_key, complete=True)


def prescan_for_projection(lines: Sequence[object]) -> PrescanIndex:
    """Prescan for a projection pass, refusing to fail the pass over it.

    Description: the seam ``message_projection.project_one`` calls BEFORE
      it opens ``BEGIN IMMEDIATE``. A prescan that raises must not cost
      the file its projection, so the failure is turned into an
      INCOMPLETE index - which makes every lookup a miss and returns the
      ingest to scanning live inside the lock. That is the pre-fix
      behaviour, which is a slow success rather than a fast failure.
    Inputs: lines (sequence of SourceLine).
    Output: PrescanIndex - complete on success, empty and incomplete when
      the scan could not be run.
    Example: prescan_for_projection([]).complete -> True
    """
    try:
        return prescan_lines(lines)
    except (ValueError, TypeError, RecursionError, MemoryError) as exc:
        # Specific, and deliberately degraded rather than raised: every
        # lookup then misses and ingest_lines scans live, so the only
        # cost is the lock hold this module exists to shorten. Swallowing
        # it into a SILENT empty-but-complete index would be the one
        # unsafe outcome, so completeness is what is withheld.
        logger.warning(
            "secret_prescan_unavailable",
            error=f"{type(exc).__name__}: {exc}",
            consequence="ingest will scan inside the write lock as before",
        )
        return PrescanIndex({}, complete=False)
