"""The integrity verdict when there are TWO databases instead of one.

THE FAILURE THIS MODULE EXISTS TO PREVENT: a gate that silently vouches
for a file it did not check. Once the archive is a separate file, the
honest answers are "both were checked and both are sound", "one of them
failed" and "only one of them was checked", and the third must never
render as the first. Two independent artifacts would make it do exactly
that, because a reader finding one record saying ``ok`` has no way to
know a second database existed at all.

SO: ONE ARTIFACT, CARRYING A LIST. The record keeps its existing scalar
``db_path`` and ``status`` fields untouched, so an older reader still
works and describes the state database exactly as it always did, and
gains a ``databases`` list of per-file verdicts. The pair verdict is a
FOLD over that list, and the fold is where all the discipline lives:

  * the pair is the WORST of the parts, in the order
    failed > cannot_determine > ok
  * ``cannot_determine`` on one part NEVER becomes ``ok`` for the pair
  * a part that is EXPECTED and ABSENT from the list is
    ``cannot_determine``, not ignored. This is the rung that stops a
    record written before the split, or by a crashed run, from reading
    as a clean bill of health for a file nobody looked at.

WHICH DATABASES ARE EXPECTED IS A MEASUREMENT, NOT A CONSTANT. The
archive file exists on a split install and does not on an unsplit one,
and both are legitimate. :func:`expected_databases` answers from the
filesystem, so the gate needs no flag, no config key and no migration to
start covering the second file the moment it appears. The state database
is always expected: it is the one file the app cannot run without.

PRACTICAL NOTE. ``PRAGMA <schema>.integrity_check`` works on an attached
database, so checking both costs one extra statement on the connection
the checker already opens, not a second connection.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from src.core.archive_db_partition import archive_db_path_for
from src.core.db import db_path_for

VERDICT_OK = "ok"
VERDICT_FAILED = "failed"
VERDICT_CANNOT_DETERMINE = "cannot_determine"

#: Worst-first. The fold takes the first verdict present in this order,
#: which is what makes "one part could not be determined" outrank "the
#: other part is fine".
_SEVERITY: Tuple[str, ...] = (
    VERDICT_FAILED,
    VERDICT_CANNOT_DETERMINE,
    VERDICT_OK,
)

#: The key the per-database list lives under on the run record.
DATABASES_KEY = "databases"

ROLE_STATE = "state"
ROLE_ARCHIVE = "archive"


def expected_databases(state_dir: Path) -> List[Tuple[str, Path]]:
    """Name the databases a complete integrity pass must cover.

    Description: MEASURED from the filesystem rather than declared. The
      state database is always expected. The archive is expected only
      when its file is actually present, so an unsplit install is not
      permanently ``cannot_determine`` for a file it does not have, and a
      split install starts being covered the moment the file appears
      without anything being reconfigured.
    Inputs: state_dir (Path) - as resolved by Settings.get_state_dir().
    Output: list[tuple[str, Path]] - (role, path), state first.
    Example: [r for r, _ in expected_databases(Path("/s"))]  # ['state']
    """
    out: List[Tuple[str, Path]] = [(ROLE_STATE, db_path_for(state_dir))]
    archive = archive_db_path_for(state_dir)
    if archive.exists():
        out.append((ROLE_ARCHIVE, archive))
    return out


def part_record(role: str, path: Path, status: str, detail: Optional[str]) -> Dict[str, Any]:
    """Build one per-database entry for the artifact's ``databases`` list.

    Description: one shape for both roles, so a reader never has to
      branch on which file it is looking at.
    Inputs: role (str - ROLE_STATE or ROLE_ARCHIVE), path (Path), status
      (str - one of the VERDICT_* constants), detail (str | None - the
      pragma's complaint, or why it could not run).
    Output: dict.
    Example: part_record("state", Path("/s/cloude.db"), "ok", None)
    """
    return {
        "role": role,
        "db_path": str(path),
        "status": status,
        "detail": detail,
    }


def fold_pair(
    record: Optional[Dict[str, Any]],
    expected: Sequence[Tuple[str, Path]],
) -> Dict[str, Any]:
    """Reduce a run record plus the expected file set to ONE verdict.

    Description: the whole point of the module. Every expected database
      must appear in the record's ``databases`` list with a verdict of
      its own; one that does not is ``cannot_determine`` and drags the
      pair down with it, because not having looked is not evidence of
      soundness. The pair verdict is the worst of the parts.

      BACKWARD COMPATIBILITY IS DELIBERATE AND NARROW. A record written
      before this module existed carries no ``databases`` list at all.
      It is read as covering the STATE database only, using its existing
      scalar ``status``, which is exactly what it meant when it was
      written. On an unsplit install that is a complete answer and folds
      to that status. On a SPLIT install the archive is expected, is
      absent from the list, and the pair correctly becomes
      ``cannot_determine`` - an old artifact cannot vouch for a file that
      did not exist when it was taken.
    Inputs: record (dict | None - as returned by
      ``db_integrity.read_verdict``), expected (Sequence[tuple[str,
      Path]] - from :func:`expected_databases`).
    Output: dict with "verdict" (str), "reason" (str), "parts"
      (list[dict]) and "unchecked" (list[str] - roles with no verdict).
    Example: fold_pair({"status": "ok"}, [("state", Path("/s/cloude.db"))])
      # {'verdict': 'ok', ...}
    """
    parts = _parts_from(record)
    by_role = {p.get("role"): p for p in parts}

    resolved: List[Dict[str, Any]] = []
    unchecked: List[str] = []
    for role, path in expected:
        part = by_role.get(role)
        if part is None:
            unchecked.append(role)
            resolved.append(part_record(
                role, path, VERDICT_CANNOT_DETERMINE,
                "no verdict for this database in the integrity artifact, so it "
                "was not checked by the run that wrote it",
            ))
        else:
            resolved.append(part)

    statuses = {_normalise(p.get("status")) for p in resolved}
    verdict = next((s for s in _SEVERITY if s in statuses), VERDICT_CANNOT_DETERMINE)

    return {
        "verdict": verdict,
        "reason": _reason(verdict, resolved, unchecked),
        "parts": resolved,
        "unchecked": unchecked,
    }


def _parts_from(record: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Extract the per-database list from a record, old shape included.

    Description: private. A record with no ``databases`` key predates the
      split and describes the state database through its scalar fields;
      it is translated rather than rejected, because rejecting it would
      make every unsplit install read ``cannot_determine`` for no reason.
    Inputs: record (dict | None).
    Output: list[dict] - possibly empty.
    Example: _parts_from(None)  # []
    """
    if not record:
        return []
    listed = record.get(DATABASES_KEY)
    if isinstance(listed, list) and listed:
        return [p for p in listed if isinstance(p, dict)]
    status = record.get("status")
    if status is None:
        return []
    return [part_record(
        ROLE_STATE,
        Path(str(record.get("db_path", ""))),
        _normalise(status),
        record.get("detail"),
    )]


def _normalise(status: Optional[str]) -> str:
    """Map a run status onto one of the three verdict words.

    Description: private. ``db_integrity`` records ``cancelled`` and
      other run outcomes that are not verdicts on a file; every one of
      them means the file was not verified, so they become
      ``cannot_determine`` rather than being treated as a pass.
    Inputs: status (str | None).
    Output: str - one of the VERDICT_* constants.
    Example: _normalise("cancelled")  # 'cannot_determine'
    """
    if status == VERDICT_OK:
        return VERDICT_OK
    if status == VERDICT_FAILED:
        return VERDICT_FAILED
    return VERDICT_CANNOT_DETERMINE


def _reason(
    verdict: str, parts: Sequence[Dict[str, Any]], unchecked: Sequence[str],
) -> str:
    """Write the sentence a human reads beside the pair verdict.

    Description: private. Names WHICH database is responsible, because
      "the database is fine" is unhelpful when there are two of them and
      actively misleading when only one was looked at.
    Inputs: verdict (str), parts (Sequence[dict]), unchecked
      (Sequence[str]).
    Output: str.
    Example: _reason("ok", [], [])
    """
    named = ", ".join(f"{p['role']}={_normalise(p.get('status'))}" for p in parts)
    if verdict == VERDICT_OK:
        return f"every database checked and sound ({named})"
    if verdict == VERDICT_FAILED:
        bad = [p["role"] for p in parts if _normalise(p.get("status")) == VERDICT_FAILED]
        return f"integrity_check failed on: {', '.join(bad)} ({named})"
    if unchecked:
        return (
            f"not every database was checked; no verdict for "
            f"{', '.join(unchecked)} ({named}). A pass that did not cover a "
            "file cannot vouch for it"
        )
    return f"the integrity of at least one database could not be determined ({named})"


def check_every_database(
    conn: sqlite3.Connection, state_dir: Path, state_verdict: str,
) -> list:
    """Run integrity_check on the state database AND the archive.

    Description: the state database's verdict is already in hand, so this
      adds the archive when its file exists. It ATTACHes rather than
      opening a second connection, because ``PRAGMA <schema>.integrity_check``
      works on an attached database and one extra statement is cheaper
      than one extra connection. A pragma that cannot run answers
      ``cannot_determine`` for THAT file only, and the fold in
      :mod:`src.core.db_integrity_pair` is what stops that being read as
      a clean bill of health for the pair.
    Inputs: conn (sqlite3.Connection - already open on the state
      database), state_dir (Path), state_verdict (str - the pragma's
      answer for the state database).
    Output: list[dict] - one part record per database, state first.
    Example: check_every_database(conn, Path("/s"), "ok")[0]["role"]
      # 'state'
    """
    parts = [part_record(
        ROLE_STATE, db_path_for(state_dir),
        "ok" if state_verdict == "ok" else "failed",
        None if state_verdict == "ok" else state_verdict,
    )]
    archive = archive_db_path_for(state_dir)
    if not archive.exists():
        return parts
    try:
        conn.execute("ATTACH DATABASE ? AS integrity_archive", (str(archive),))
        row = conn.execute("PRAGMA integrity_archive.integrity_check").fetchone()
        answer = None if row is None else row[0]
        parts.append(part_record(
            ROLE_ARCHIVE, archive,
            "ok" if answer == "ok" else "failed",
            None if answer == "ok" else (answer or "the pragma returned no row"),
        ))
    except sqlite3.Error as exc:
        parts.append(part_record(
            ROLE_ARCHIVE, archive, "cannot_determine",
            f"{type(exc).__name__}: {exc}",
        ))
    finally:
        try:
            conn.execute("DETACH DATABASE integrity_archive")
        except sqlite3.Error:
            # Nothing was attached, which is the only way this raises
            # here and is not a fault worth reporting.
            pass
    return parts
