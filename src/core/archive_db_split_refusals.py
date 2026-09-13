"""Every reason the archive split refuses, and which kind of reason it is.

THE PROJECT RULE THIS MODULE ENCODES: a MEASURED absence refuses, an
UNCHECKED one does not. Not having looked is not evidence of absence, so
a rung that could not take its reading must say so and stand aside rather
than manufacture a verdict in either direction. Each rung below records
which kind it is in ``KIND``, and :func:`refusals_for` only ever refuses
on the measured ones.

THE MIGRATION'S SPINE, which is what makes these rungs sufficient: THE
SOURCE IS NEVER DROPPED UNTIL EVERY TABLE HAS BEEN COPIED AND VERIFIED IN
THE SAME RUN. Until that moment the whole operation is abortable at zero
cost by deleting the destination file. So the rungs divide into
pre-flight (refuse before writing anything) and pre-drop (refuse before
the one destructive step), and a verification from an EARLIER run never
licenses a drop, because the file may have changed since it was taken.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence

#: A reading was taken and it says no. These refuse.
KIND_MEASURED = "measured"

#: A reading could not be taken. These are recorded and do NOT refuse,
#: because refusing on an unchecked condition would make the migration
#: impossible to run on any machine the checker does not understand.
KIND_UNCHECKED = "unchecked"

# Pre-flight rungs, evaluated before anything is written.
SOURCE_UNREADABLE = "source_unreadable"
SOURCE_INTEGRITY_FAILED = "source_integrity_failed"
SCHEMA_VERSION_UNEXPECTED = "schema_version_unexpected"
UNCLASSIFIED_OBJECT = "unclassified_object"
CROSSING_FK_SET_CHANGED = "crossing_fk_set_changed"
ORPHANED_REFERENCE = "orphaned_reference"
DEST_EXISTS_FOREIGN = "destination_exists_and_is_not_ours"
INSUFFICIENT_DISK = "insufficient_disk"

# Pre-drop rungs, evaluated after the copy and before the destructive step.
COUNT_MISMATCH = "row_count_mismatch"
CONTENT_MISMATCH = "content_sample_mismatch"
CONSTRAINT_NOT_STRIPPED = "crossing_constraint_not_stripped"
DEST_INTEGRITY_FAILED = "destination_integrity_failed"
SOURCE_CHANGED_DURING_COPY = "source_changed_during_copy"
DEST_FK_VIOLATIONS = "destination_foreign_key_violations"

# Recorded, never refusing.
DISK_CANNOT_BE_DETERMINED = "disk_headroom_cannot_be_determined"
SCHEMA_VERSION_UNREADABLE = "schema_version_unreadable"

#: Free bytes required beyond the measured archive size, so a copy cannot
#: fill the volume to zero and take the app's own state down with it.
DISK_MARGIN_BYTES = 2 * 1024 * 1024 * 1024


@dataclass(frozen=True)
class Refusal:
    """One reason the migration declined to proceed.

    Description: carries the rung name, whether the reading behind it was
      actually taken, and a sentence a human can act on. A refusal is
      data, not an exception, so a dry run can report all of them at once
      rather than stopping at the first.
    Inputs: rung (str - one of the constants above), kind (str -
      KIND_MEASURED or KIND_UNCHECKED), detail (str).
    Output: a frozen record.
    """

    rung: str
    kind: str
    detail: str

    @property
    def blocking(self) -> bool:
        """True when this refusal must stop the migration.

        Description: only a MEASURED refusal blocks. An unchecked one is
          published so the operator knows what went unverified.
        Inputs: none.
        Output: bool.
        Example: Refusal("x", KIND_UNCHECKED, "").blocking  # False
        """
        return self.kind == KIND_MEASURED


def _as_version_set(expected) -> frozenset:
    """Accept either one schema version or a collection of them.

    Description: private. The rung is written against a SET of versions
      whose partition has actually been measured, but a single int is
      still a valid and readable way to say "only this one", and tests
      use it that way.
    Inputs: expected (int | Iterable[int]).
    Output: frozenset[int].
    Example: _as_version_set(25)  # frozenset({25})
    """
    if isinstance(expected, int):
        return frozenset({expected})
    return frozenset(expected)


def blocking(refusals: Sequence[Refusal]) -> List[Refusal]:
    """Filter a refusal list down to the ones that stop the run.

    Description: one place that applies the measured/unchecked rule, so
      no caller re-implements it and quietly gets the direction wrong.
    Inputs: refusals (Sequence[Refusal]).
    Output: list[Refusal] - those whose ``blocking`` is True.
    Example: blocking([Refusal("a", KIND_UNCHECKED, "")])  # []
    """
    return [r for r in refusals if r.blocking]


def preflight_refusals(
    *,
    source_integrity: Optional[str],
    schema_version: Optional[int],
    expected_schema_version,
    unclassified: Sequence[str],
    crossings: Sequence[tuple],
    expected_crossings: Sequence[tuple],
    orphans: Dict[str, int],
    destination_state: str,
    free_bytes: Optional[int],
    archive_bytes: int,
) -> List[Refusal]:
    """Evaluate every pre-flight rung against readings already taken.

    Description: PURE. It takes measurements and returns verdicts, so the
      ladder can be tested without a database. ``None`` means the reading
      could not be taken and produces an UNCHECKED entry; a real value
      that disagrees produces a MEASURED one. Note the asymmetry on disk:
      a measured shortfall refuses, an unmeasurable volume does not.
    Inputs: source_integrity (str | None - the pragma's answer, 'ok' or
      its complaint, None when it could not run), schema_version (int |
      None), expected_schema_version (int), unclassified (Sequence[str] -
      from partition.unclassified_objects), crossings and
      expected_crossings (Sequences of (child, column, parent) tuples),
      orphans (dict of "child.column" -> count), destination_state (str -
      'absent', 'ours' or 'foreign'), free_bytes (int | None),
      archive_bytes (int - measured size of what is about to be copied).
    Output: list[Refusal], in ladder order.
    Example: preflight_refusals(source_integrity="ok", schema_version=25,
        expected_schema_version=25, unclassified=[], crossings=[],
        expected_crossings=[], orphans={}, destination_state="absent",
        free_bytes=10**12, archive_bytes=1)  # []
    """
    out: List[Refusal] = []

    if source_integrity is None:
        out.append(Refusal(
            SOURCE_UNREADABLE, KIND_MEASURED,
            "the source database could not be opened or its integrity check "
            "could not be run; migrating out of a file we cannot read risks "
            "propagating corruption into the archive",
        ))
    elif source_integrity != "ok":
        out.append(Refusal(
            SOURCE_INTEGRITY_FAILED, KIND_MEASURED,
            f"PRAGMA integrity_check on the source answered {source_integrity!r}",
        ))

    if schema_version is None:
        out.append(Refusal(
            SCHEMA_VERSION_UNREADABLE, KIND_UNCHECKED,
            "meta.schema_version could not be read, so it was not confirmed "
            "that this migration matches the schema in front of it",
        ))
    elif schema_version not in _as_version_set(expected_schema_version):
        out.append(Refusal(
            SCHEMA_VERSION_UNEXPECTED, KIND_MEASURED,
            f"the database is at schema v{schema_version} and this migration "
            f"has only been measured against "
            f"{sorted(_as_version_set(expected_schema_version))}; a version "
            "nobody has looked at may carry a crossing foreign key this code "
            "has never seen",
        ))

    if unclassified:
        out.append(Refusal(
            UNCLASSIFIED_OBJECT, KIND_MEASURED,
            "the partition map could not place: " + ", ".join(unclassified) +
            "; leaving an unknown table behind is a half-done split and "
            "moving it risks putting irreplaceable state in a file the "
            "backup policy treats as rebuildable",
        ))

    if tuple(sorted(crossings)) != tuple(sorted(expected_crossings)):
        out.append(Refusal(
            CROSSING_FK_SET_CHANGED, KIND_MEASURED,
            f"the crossing foreign keys measured now are {sorted(crossings)!r} "
            f"and this migration expects {sorted(expected_crossings)!r}; the "
            "line has moved and a human has to decide each one",
        ))

    orphaned = {k: v for k, v in orphans.items() if v}
    if orphaned:
        out.append(Refusal(
            ORPHANED_REFERENCE, KIND_MEASURED,
            f"crossing references already orphaned: {orphaned!r}; the forward "
            "split would not notice, but the REVERSE re-imposes these "
            "constraints and could not succeed, so proceeding would turn a "
            "two-way door into a one-way one",
        ))

    if destination_state == "foreign":
        out.append(Refusal(
            DEST_EXISTS_FOREIGN, KIND_MEASURED,
            "a database already exists at the destination and does not carry "
            "this install's marker; it will not be overwritten",
        ))

    if free_bytes is None:
        out.append(Refusal(
            DISK_CANNOT_BE_DETERMINED, KIND_UNCHECKED,
            "free space on the destination volume could not be measured, so "
            "headroom was not established; the copy may still succeed",
        ))
    elif free_bytes < archive_bytes + DISK_MARGIN_BYTES:
        out.append(Refusal(
            INSUFFICIENT_DISK, KIND_MEASURED,
            f"{free_bytes} bytes free, and the copy needs {archive_bytes} plus "
            f"a {DISK_MARGIN_BYTES} byte margin; running out of disk mid-copy "
            "is the classic half-done migration",
        ))

    return out


def predrop_refusals(
    *,
    count_mismatches: Dict[str, tuple],
    content_mismatches: Sequence[str],
    write_probe_failures: Dict[str, str],
    destination_integrity: Optional[str],
    source_drift: Optional[Dict[str, tuple]] = None,
    fk_violations: Optional[Sequence[tuple]] = None,
) -> List[Refusal]:
    """Evaluate every rung guarding the one destructive step.

    Description: PURE, same as the pre-flight ladder. All four rungs must
      be clear IN THE SAME RUN for the source tables to be dropped.
      ``write_probe_failures`` is the rung the scope doc did not know it
      needed: a REFERENCES clause that survived into the archive creates
      a table that accepts DDL, passes ``foreign_key_check``, and refuses
      every insert forever. Only an actual write catches it, which is why
      this takes probe results rather than DDL strings.

      ``source_drift`` is the live-install rung. The owner runs this with
      the server up, so the ingester can append while the copy is in
      flight. A table whose SOURCE count moved between planning and
      verification was copied from a moving target, and dropping it would
      discard rows the archive never received. The copy is re-runnable,
      so the answer is to refuse the drop and re-run, not to guess.
    Inputs: count_mismatches (dict of table -> (source_n, dest_n)),
      content_mismatches (Sequence[str] - identifiers whose sampled
      content did not round-trip), write_probe_failures (dict of table ->
      the sqlite error text), destination_integrity (str | None),
      source_drift (dict of table -> (count_at_plan, count_at_verify) |
      None when the comparison was not taken).
    Output: list[Refusal], in ladder order.
    Example: predrop_refusals(count_mismatches={}, content_mismatches=[],
        write_probe_failures={}, destination_integrity="ok")  # []
    """
    out: List[Refusal] = []

    if fk_violations:
        shown = "; ".join(
            f"{v[0]} row {v[1]} -> {v[2]}" for v in list(fk_violations)[:10]
        )
        out.append(Refusal(
            DEST_FK_VIOLATIONS, KIND_MEASURED,
            f"PRAGMA foreign_key_check found {len(fk_violations)} violation(s) "
            f"in the copied archive: {shown}. The bulk copy runs with "
            "enforcement OFF because a rowid-ordered insert necessarily "
            "writes a self-referencing child before its parent (measured on "
            "the live data: 16,387 forward references in transcript_archives), "
            "so THIS is where that integrity is established. A violation here "
            "means the copy is genuinely wrong, not merely out of order",
        ))

    if source_drift:
        detail = "; ".join(
            f"{t}: {a} rows at plan, {b} at verify"
            for t, (a, b) in sorted(source_drift.items())
        )
        out.append(Refusal(
            SOURCE_CHANGED_DURING_COPY, KIND_MEASURED,
            f"the source changed while the copy was running: {detail}. "
            "Re-run the copy; it is re-runnable and will pick up the new rows",
        ))

    if count_mismatches:
        detail = "; ".join(
            f"{t}: source {a} rows, destination {b}"
            for t, (a, b) in sorted(count_mismatches.items())
        )
        out.append(Refusal(
            COUNT_MISMATCH, KIND_MEASURED,
            f"row counts disagree after the copy: {detail}",
        ))

    if content_mismatches:
        out.append(Refusal(
            CONTENT_MISMATCH, KIND_MEASURED,
            "sampled content did not round-trip for: "
            + ", ".join(sorted(content_mismatches)[:20]),
        ))

    if write_probe_failures:
        detail = "; ".join(
            f"{t}: {e}" for t, e in sorted(write_probe_failures.items())
        )
        out.append(Refusal(
            CONSTRAINT_NOT_STRIPPED, KIND_MEASURED,
            "a cross-database REFERENCES survived into the archive, so these "
            f"tables are unwritable: {detail}. Reading the DDL back would not "
            "catch this and PRAGMA foreign_key_check passes it silently",
        ))

    if destination_integrity is None:
        out.append(Refusal(
            DEST_INTEGRITY_FAILED, KIND_MEASURED,
            "PRAGMA integrity_check on the destination could not be run, so "
            "the copy was never verified sound and the source must stand",
        ))
    elif destination_integrity != "ok":
        out.append(Refusal(
            DEST_INTEGRITY_FAILED, KIND_MEASURED,
            f"PRAGMA integrity_check on the destination answered "
            f"{destination_integrity!r}",
        ))

    return out
