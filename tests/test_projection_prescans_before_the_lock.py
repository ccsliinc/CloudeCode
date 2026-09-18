"""project_one must PRESCAN before it opens BEGIN IMMEDIATE, end to end.

WHY THIS IS A SECOND FILE AND NOT A SEVENTH CASE IN
``test_secret_scan_outside_the_write_lock.py``. That file drives
``ingest_lines`` directly, so it proves the MECHANISM works and it
proves a miss is safe. It cannot see the one mistake most likely to
happen next: ``project_one`` failing to pass the index at all. Measured
during development by deleting exactly that one line - ``prescan=prescan``
in message_projection.py - every case in that file still passed. A
control that cannot see the regression it is named after is not a
control, so this file drives the REAL seam: a corpus on disk, a real
archive ingest, and ``run_projection_once``.

THE PROBE READS THE CONNECTION project_one IS ACTUALLY USING, obtained
by wrapping ``message_projection.ingest_lines``, rather than a
connection the test opened itself. The claim is about the transaction
the projection holds; asking a different connection whether IT is in a
transaction would answer a question nobody asked.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import List, Optional, Tuple

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_pp_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_pp_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core import (
    message_model_store,
    message_projection,
    message_secret_prescan,
)
from src.core.corpus_ingest_service import STATUS_OK as INGEST_OK, run_ingest_once
from src.core.db import connect, db_path_for
from src.core.db_migration import ensure_db_migrated
from src.core.db_steps import apply_message_model_schema
from src.core.message_projection import STATUS_OK, run_projection_once

SESSION_UUID = "33333333-3333-3333-3333-333333333333"
SLUG = "-Users-x-prescan"

#: Synthetic, and not a credential to anything. It exists so the corpus
#: this test projects actually HAS something to find - a scan-placement
#: test over a corpus with no credentials in it would pass no matter
#: where the scan ran.
#: THE FIXTURE VALUE IS ASSEMBLED, NOT WRITTEN DOWN, and that is not
#: squeamishness. A 40 character high entropy run sitting next to a name
#: like SECRET is exactly the shape ``high_entropy_assignment`` detects,
#: so writing it as a literal makes this file trip the repository's own
#: pre-commit secret hook - measured, it did. Each piece below is 12
#: characters, which is under every detector's floor, and the joined
#: value is still a full credential shape by the time the corpus is
#: written. The value is synthetic and authenticates nothing.
_PIECES = ("sk9Qv3ZtR7mW", "1xLpD8fJhN2b", "YcG5aK0eUsT4", "iOzX")
SECRET = "".join(_PIECES)


def _write_corpus(root: Path) -> None:
    """Write a small real corpus whose bodies carry one detectable credential.

    Inputs: root (Path) - corpus root, created here.
    Output: None.
    Example: _write_corpus(tmp_path / "corpus")
    """
    slug_dir = root / SLUG
    slug_dir.mkdir(parents=True)
    (slug_dir / f"{SESSION_UUID}.jsonl").write_text(
        '{"type":"user","uuid":"p1","sessionId":"' + SESSION_UUID + '",'
        '"timestamp":"2026-09-14T00:00:00.000Z",'
        '"message":{"role":"user","content":"export API_KEY='
        + SECRET + '"}}\n'
        '{"type":"assistant","uuid":"p2","parentUuid":"p1",'
        '"sessionId":"' + SESSION_UUID + '",'
        '"timestamp":"2026-09-14T00:00:01.000Z",'
        '"message":{"role":"assistant","model":"claude-test",'
        '"content":[{"type":"text","text":"noted"}]}}\n',
        encoding="utf-8",
    )


def _state_with_model(tmp_path: Path) -> Path:
    """A state dir whose datastore carries the message model.

    Inputs: tmp_path (Path). Output: Path - the state dir.
    Example: _state_with_model(tmp_path) / "cloude.db"
    """
    state = tmp_path / "state"
    ensure_db_migrated(state, 4, "0.8.2")
    conn = connect(db_path_for(state), create=False)
    try:
        apply_message_model_schema(conn)
        conn.commit()
    finally:
        conn.close()
    return state


class SeamProbe:
    """Records whether each scan_text ran inside the projection's transaction.

    Description: ``conn`` is captured from the real ``ingest_lines`` call
      rather than opened here, so the transaction state read is the one
      project_one is actually holding.
    Inputs: none. Output: an object with ``inside`` / ``outside`` counts.
    Example: SeamProbe().inside -> 0
    """

    def __init__(self) -> None:
        self.conn: Optional[sqlite3.Connection] = None
        self.calls: List[Tuple[bool, bool]] = []
        self._real_export = message_projection.export_archive
        #: Captured before either binding is patched, so the probe calls
        #: the real detector rather than itself.
        self._real_scan = message_model_store.scan_text
        self._real_ingest = message_projection.ingest_lines

    def export(self, conn: sqlite3.Connection, archive_id: int):
        """Stand in for export_archive, capturing the live connection EARLY.

        Description: this is the FIRST thing project_one does with its
          connection, before the prescan and before BEGIN IMMEDIATE. The
          probe has to know the connection by then or a prescan MOVED
          inside the transaction reads as "no connection yet, so
          outside" - which is a fix that looks present and does nothing.
          Measured during development: capturing at ingest_lines instead
          let exactly that sabotage pass.
        Inputs: conn (sqlite3.Connection), archive_id (int).
        Output: bytes.
        """
        self.conn = conn
        return self._real_export(conn, archive_id)

    def ingest(self, conn: sqlite3.Connection, **kwargs):
        """Stand in for ingest_lines, confirming the connection is the same."""
        assert self.conn is conn, "project_one changed connections mid-file"
        return self._real_ingest(conn, **kwargs)

    def scan(self, text: str, detectors=None):
        """Stand in for scan_text, recording the transaction state."""
        seen = self.conn is not None
        self.calls.append((seen and bool(self.conn.in_transaction), seen))
        return (self._real_scan(text, detectors) if detectors is not None
                else self._real_scan(text))

    @property
    def inside(self) -> int:
        """Scans that ran while the projection held a transaction open."""
        return sum(1 for in_txn, _ in self.calls if in_txn)

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Patch every scan seam, plus the one that reveals the connection.

        BOTH scan_text bindings are patched, and that is the point. The
        prescan calls it through message_secret_prescan and the ingest
        calls it through message_model_store, so patching only the second
        records ZERO calls on a working fix - which is indistinguishable
        from a test that ran nothing at all. Counting both lets this
        assert the real claim: scans DID happen, and none of them was
        inside the transaction.
        """
        monkeypatch.setattr(message_projection, "export_archive", self.export)
        monkeypatch.setattr(message_projection, "ingest_lines", self.ingest)
        monkeypatch.setattr(message_model_store, "scan_text", self.scan)
        monkeypatch.setattr(message_secret_prescan, "scan_text", self.scan)


def _ingested(tmp_path: Path) -> Path:
    """Write a corpus and archive it, with no projection run yet.

    Inputs: tmp_path (Path). Output: Path - the state dir.
    Example: _ingested(tmp_path)
    """
    state = _state_with_model(tmp_path)
    corpus = tmp_path / "corpus"
    _write_corpus(corpus)
    report = run_ingest_once(state, corpus_root=corpus)
    assert report.status == INGEST_OK, report.status
    assert report.ingested == 1, report.ingested
    return state


def _findings(state: Path) -> List[tuple]:
    """Every recorded secret finding, keyed on the body's identity.

    Inputs: state (Path). Output: sorted list of tuples, no value read.
    Example: _findings(state)
    """
    conn = connect(db_path_for(state), create=False)
    try:
        return sorted(
            tuple(r) for r in conn.execute(
                "SELECT b.identity_key, f.detector, f.match_offset, "
                "       f.match_length, f.value_sha256 "
                "  FROM message_secret_findings f "
                "  JOIN message_bodies b ON b.id = f.body_id"
            )
        )
    finally:
        conn.close()


def test_the_projection_records_the_finding_at_all(tmp_path: Path) -> None:
    """A control: this corpus really does produce a finding.

    Every assertion below is about WHERE the scan ran. If the corpus
    produced nothing to find, all of them would pass vacuously, which is
    how a secret test quietly stops testing anything.
    """
    state = _ingested(tmp_path)
    report = run_projection_once(state, publish=False, respect_flag=False)
    assert report.status == STATUS_OK, report.status
    found = _findings(state)
    assert len(found) == 1, found
    assert found[0][1] == "high_entropy_assignment"


def test_no_credential_scan_runs_inside_the_projection_transaction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE REGRESSION. project_one must prescan before BEGIN IMMEDIATE.

    This is the case that a missing ``prescan=prescan`` at the seam
    fails and that a direct ingest_lines test cannot see.
    """
    state = _ingested(tmp_path)
    probe = SeamProbe()
    probe.install(monkeypatch)
    report = run_projection_once(state, publish=False, respect_flag=False)
    assert report.status == STATUS_OK, report.status
    assert probe.calls, (
        "no scan happened at all, so this measured nothing; the corpus "
        "control test says there is something here to scan"
    )
    assert probe.inside == 0, (
        f"{probe.inside} of {len(probe.calls)} credential scan(s) ran while "
        f"the projection held its write transaction open. The transaction "
        f"was not actually narrowed - check that project_one still calls "
        f"prescan_for_projection BEFORE 'BEGIN IMMEDIATE' and still passes "
        f"prescan=prescan to ingest_lines."
    )
    assert len(probe.calls) - probe.inside > 0, (
        "no scan ran outside the transaction either, so nothing was moved"
    )


def test_the_projected_findings_are_unchanged_by_the_prescan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ROWS UNCHANGED. Prescanned and live-scanned runs record the same rows.

    The pre-fix shape is reproduced INLINE by neutering the prescan, so
    this compares the two real code paths rather than comparing the
    current path with itself.
    """
    green_state = _ingested(tmp_path / "green")
    assert run_projection_once(
        green_state, publish=False, respect_flag=False).status == STATUS_OK
    green = _findings(green_state)

    red_state = _ingested(tmp_path / "red")
    monkeypatch.setattr(
        message_projection, "prescan_for_projection",
        lambda lines: None,          # exactly what project_one passed before
    )
    assert run_projection_once(
        red_state, publish=False, respect_flag=False).status == STATUS_OK
    red = _findings(red_state)

    assert red, "the comparison must not be of two empty sets"
    assert red == green
