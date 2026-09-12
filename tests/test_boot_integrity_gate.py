"""Boot may skip PRAGMA integrity_check, and only on one rung.

WHAT IS BEING PROVEN, AND WHICH TEST IS LOAD-BEARING.

``ensure_db_migrated`` used to walk every page of cloude.db on every
start: 51.8 s of a 55 s startup window on the owner's 5.4 GB file, with
the port shut for all of it. It may now stand on the daily background
checker's verdict instead - but ONLY when that verdict is positive,
fresh, and demonstrably about THIS database. Everything else re-measures.

The tests that matter here are not the happy path. A gate that answered
"skip" unconditionally would pass every positive assertion in this file
and would be the worst possible defect in the codebase: it would migrate
a corrupt database and tell the user it was sound. So every refusal rung
is proven by COUNTING whether the expensive walk actually happened
(``_walk_counter``), not by reading back a label the implementation chose
for itself, and two end-to-end tests run a genuinely corrupted SQLite
file through the real ``ensure_db_migrated``:

  * test_a_refused_cache_still_catches_a_corrupt_database - the headline.
    Fresh ok verdict, wrong install_id, real corruption, and the app must
    still refuse to trust the file.
  * test_a_skip_really_skips_the_walk - the inverse control. Without it,
    an implementation that quietly never skips would satisfy every other
    assertion in this file while delivering none of the speedup.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_bgate_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_bgate_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core import db_integrity_gate as gate
from src.core.db import connect, db_path_for
from src.core.db_integrity import ENABLE_ENV, latest_path, read_verdict
from src.core.db_integrity_status import classify_record
from src.core.db_migration import ensure_db_migrated
from src.core.db_state import STATUS_DEGRADED_DB_UNREADABLE, STATUS_OK

APP_VERSION = "0.0.0-test"


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def checker_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """Switch the background checker on for this test.

    Description: under CLOUDE_TEST_MODE the checker defaults OFF, which
      makes the gate refuse on its first rung. A test that wants to
      exercise any other rung has to opt in, exactly as a test wanting
      the checker itself does.
    Inputs: monkeypatch (pytest.MonkeyPatch).
    Output: None.
    """
    monkeypatch.setenv(ENABLE_ENV, "1")


def _walk_counter(monkeypatch: pytest.MonkeyPatch) -> List[str]:
    """Record every time the real integrity pragma is walked.

    Description: the behavioural probe this whole file turns on. It wraps
      the pragma rather than replacing it, so the verdict a test sees is
      still the database's own answer and a corrupt file is still caught.
    Inputs: monkeypatch (pytest.MonkeyPatch).
    Output: list[str] - one entry per walk, holding that walk's verdict.
    Example: calls = _walk_counter(monkeypatch); assert calls == []
    """
    seen: List[str] = []
    real = gate.integrity_check

    def _counting(conn: sqlite3.Connection) -> str:
        """Delegate to the real pragma and note that it ran."""
        verdict = real(conn)
        seen.append(verdict)
        return verdict

    monkeypatch.setattr(gate, "integrity_check", _counting, raising=True)
    return seen


def _built_state_dir(tmp_path: Path) -> Path:
    """Create a real, migrated cloude.db with a cached verdict bound to it.

    Description: TWO boots, and the second one is not padding. The first
      boot runs before the schema exists, so there is no ``meta`` table to
      read an install_id from and the verdict it publishes carries None.
      The second boot therefore refuses on ``install_id_unrecorded``,
      walks the database again and publishes a verdict that IS bound to
      this install. Every test below starts from that second state.
      See test_a_fresh_install_takes_two_boots_to_bind for the property
      itself.
    Inputs: tmp_path (Path).
    Output: Path - the state directory.
    """
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    for _ in range(2):
        result = ensure_db_migrated(state_dir, 4, APP_VERSION)
        assert result.status == STATUS_OK, result.message
    bound = read_verdict(state_dir)
    assert bound and bound.get("install_id"), "the artifact never bound"
    return state_dir


def _rewrite_artifact(state_dir: Path, **changes: Any) -> Dict[str, Any]:
    """Apply changes to the cached verdict on disk and return the result.

    Inputs: state_dir (Path), changes (Any) - fields to override.
    Output: dict - the record now on disk.
    Example: _rewrite_artifact(state_dir, status="failed")["status"]
    """
    path = latest_path(state_dir)
    record = json.loads(path.read_text())
    record.update(changes)
    path.write_text(json.dumps(record, indent=2, sort_keys=True))
    return record


def _stamp(seconds_ago: float) -> str:
    """Return an ISO-8601 UTC stamp that many seconds in the past.

    Inputs: seconds_ago (float) - negative values land in the future.
    Output: str.
    Example: _stamp(0)[-1] -> 'Z' or an offset
    """
    moment = datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)
    return moment.isoformat().replace("+00:00", "Z")


def _corrupt(db_path: Path) -> None:
    """Damage a real SQLite file so it opens but fails integrity_check.

    Description: four bytes flipped inside a leaf page well past the
      header. The file still opens and still answers queries; the pragma
      reports the index row that no longer matches its table. Chosen over
      heavier damage on purpose: a file that cannot even be opened would
      take the connect() refusal and would prove nothing about the gate.
    Inputs: db_path (Path).
    Output: None.
    """
    seed = sqlite3.connect(str(db_path))
    try:
        seed.execute("CREATE TABLE gate_probe(id INTEGER PRIMARY KEY, v TEXT)")
        seed.execute("CREATE INDEX gate_probe_v ON gate_probe(v)")
        seed.executemany(
            "INSERT INTO gate_probe(v) VALUES(?)",
            [("x" * 180 + str(i),) for i in range(4000)],
        )
        seed.commit()
        # The app runs in WAL mode, so the rows just written live in the
        # -wal file until a checkpoint folds them into cloude.db. Damaging
        # the main file before that would damage pages nothing reads.
        seed.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        seed.execute("PRAGMA journal_mode=DELETE")
        seed.commit()
    finally:
        seed.close()
    page_size = 4096
    pages = db_path.stat().st_size // page_size
    assert pages > 40, "the probe table did not make the file big enough"
    with open(db_path, "r+b") as handle:
        handle.seek(page_size * (pages - 5) + 1000)
        handle.write(b"\x00\xff\x00\xff")


def _sound_record(db_path: Path) -> Dict[str, Any]:
    """Return a record that passes every rung, for the pure ladder tests.

    Inputs: db_path (Path).
    Output: dict.
    """
    return {
        "status": "ok",
        "finished_at": _stamp(60),
        "detail": None,
        "db_path": str(db_path),
        "install_id": "install-abc",
        "db_size_bytes": 1000,
        "source": "scheduled",
    }


def _decide(record: Optional[Dict[str, Any]], **over: Any) -> Any:
    """Run the pure ladder over a record, defaulting the live facts to agree.

    Inputs: record (dict | None), over (Any) - override enabled,
      db_path, live_install_id or live_size_bytes.
    Output: BootIntegrityDecision.
    """
    db_path = over.pop("db_path", Path("/s/cloude.db"))
    return gate.resolve_boot_integrity(
        enabled=over.pop("enabled", True),
        record=record,
        reading=classify_record(record),
        db_path=db_path,
        live_install_id=over.pop("live_install_id", "install-abc"),
        live_size_bytes=over.pop("live_size_bytes", 1000),
    )


# ---------------------------------------------------------------------------
# The two end-to-end controls
# ---------------------------------------------------------------------------


def test_a_refused_cache_still_catches_a_corrupt_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """THE HEADLINE. A refusal re-measures, and the measurement governs.

    A perfectly fresh ``ok`` verdict sits on disk. It was taken on a
    different install, so it may not stand for this file - and this file
    is genuinely damaged. The app must refuse to trust it, exactly as it
    did when the pragma ran unconditionally.
    """
    state_dir = _built_state_dir(tmp_path)
    _corrupt(db_path_for(state_dir))
    _rewrite_artifact(
        state_dir,
        status="ok",
        detail=None,
        finished_at=_stamp(30),
        install_id="some-other-install",
    )
    calls = _walk_counter(monkeypatch)

    result = ensure_db_migrated(state_dir, 4, APP_VERSION)

    assert calls, "the gate trusted a verdict taken on another install"
    assert result.status == STATUS_DEGRADED_DB_UNREADABLE
    assert "integrity_check" in (result.detail or "")


def test_a_skip_really_skips_the_walk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """THE INVERSE CONTROL. A gate that never skips delivers nothing.

    Same corrupted file, but this time the cached verdict genuinely
    belongs to it and is inside its window. Boot stands on it and does
    NOT walk the file. This asserts the trade the feature exists to make,
    out loud: within the freshness window, damage arising after the last
    check is not seen until the next one.
    """
    state_dir = _built_state_dir(tmp_path)
    before = read_verdict(state_dir)
    assert before is not None
    _corrupt(db_path_for(state_dir))
    _rewrite_artifact(state_dir, finished_at=_stamp(30))
    calls = _walk_counter(monkeypatch)

    result = ensure_db_migrated(state_dir, 4, APP_VERSION)

    assert calls == [], "the cached ok verdict was not used"
    assert result.status == STATUS_OK


# ---------------------------------------------------------------------------
# Every refusal rung, proven by whether the walk happened
# ---------------------------------------------------------------------------


def _assert_walked(state_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Boot this state directory and assert the pragma actually ran.

    Inputs: state_dir (Path), monkeypatch (pytest.MonkeyPatch).
    Output: None.
    """
    calls = _walk_counter(monkeypatch)
    result = ensure_db_migrated(state_dir, 4, APP_VERSION)
    assert result.status == STATUS_OK, result.message
    assert calls, "the gate skipped the pragma when it had to run it"


def test_a_missing_artifact_runs_the_pragma(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """never_ran. Never having looked is not evidence of soundness."""
    state_dir = _built_state_dir(tmp_path)
    os.replace(latest_path(state_dir), tmp_path / "moved-away.json")
    _assert_walked(state_dir, monkeypatch)


def test_a_truncated_artifact_runs_the_pragma(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """A half-written artifact is unreadable, not empty and not healthy."""
    state_dir = _built_state_dir(tmp_path)
    text = latest_path(state_dir).read_text()
    latest_path(state_dir).write_text(text[: len(text) // 2])
    _assert_walked(state_dir, monkeypatch)


def test_a_malformed_artifact_runs_the_pragma(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """Bytes that are not a JSON object tell us nothing."""
    state_dir = _built_state_dir(tmp_path)
    latest_path(state_dir).write_text("[not, an, object")
    _assert_walked(state_dir, monkeypatch)


def test_an_unparseable_stamp_runs_the_pragma(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """cannot_determine on freshness: an age that was never measured."""
    state_dir = _built_state_dir(tmp_path)
    _rewrite_artifact(state_dir, finished_at="the day before yesterday")
    _assert_walked(state_dir, monkeypatch)


def test_a_future_stamp_runs_the_pragma(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """A clock that moved makes the age real arithmetic on an unreal input."""
    state_dir = _built_state_dir(tmp_path)
    _rewrite_artifact(state_dir, finished_at=_stamp(-3600))
    _assert_walked(state_dir, monkeypatch)


def test_a_stale_verdict_runs_the_pragma(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """Past two check intervals, the verdict stops standing for the file."""
    state_dir = _built_state_dir(tmp_path)
    _rewrite_artifact(state_dir, finished_at=_stamp(4 * 24 * 60 * 60))
    _assert_walked(state_dir, monkeypatch)


def test_a_recorded_failure_runs_the_pragma(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """A cached failure re-measures rather than becoming permanent.

    The database here is sound, so the live walk says so and the app
    starts normally. Short-circuiting on the cached complaint instead
    would strand a restored install read-only forever, with a cached
    verdict outranking a live one.
    """
    state_dir = _built_state_dir(tmp_path)
    _rewrite_artifact(
        state_dir, status="failed", detail="page 3 is never used",
        finished_at=_stamp(30),
    )
    _assert_walked(state_dir, monkeypatch)


def test_a_cancelled_run_runs_the_pragma(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """cannot_determine on the verdict: a run that produced no answer."""
    state_dir = _built_state_dir(tmp_path)
    _rewrite_artifact(state_dir, status="cancelled", finished_at=_stamp(30))
    _assert_walked(state_dir, monkeypatch)


def test_a_verdict_for_another_path_runs_the_pragma(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """The verdict has to be about the file being opened."""
    state_dir = _built_state_dir(tmp_path)
    _rewrite_artifact(state_dir, db_path="/somewhere/else/cloude.db")
    _assert_walked(state_dir, monkeypatch)


def test_a_verdict_without_an_install_id_runs_the_pragma(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """An artifact predating identity binding cannot be shown to fit.

    This is the rung every existing install lands on the first time this
    code runs, which is why the first boot after it ships is still slow.
    """
    state_dir = _built_state_dir(tmp_path)
    _rewrite_artifact(state_dir, install_id=None)
    _assert_walked(state_dir, monkeypatch)


def test_a_verdict_for_another_install_runs_the_pragma(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """A different database dropped in at the same path."""
    state_dir = _built_state_dir(tmp_path)
    _rewrite_artifact(state_dir, install_id="a-different-install")
    _assert_walked(state_dir, monkeypatch)


def test_a_database_that_shrank_runs_the_pragma(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """SQLite does not shrink, so a smaller file is a different file."""
    state_dir = _built_state_dir(tmp_path)
    _rewrite_artifact(state_dir, db_size_bytes=10 * 1024 * 1024 * 1024)
    _assert_walked(state_dir, monkeypatch)


def test_a_disabled_checker_runs_the_pragma(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """Nothing refreshes the cache, so the cache may not be trusted."""
    state_dir = _built_state_dir(tmp_path)
    _rewrite_artifact(state_dir, finished_at=_stamp(30))
    monkeypatch.setenv(ENABLE_ENV, "0")
    _assert_walked(state_dir, monkeypatch)


# ---------------------------------------------------------------------------
# The pure ladder, rung by rung
# ---------------------------------------------------------------------------


def test_exactly_one_rung_skips() -> None:
    """The ladder has ONE way to skip and ten ways to refuse.

    A new rung that skips is the defect this whole file guards against,
    so the count is pinned rather than left to review.
    """
    assert gate.SKIP_CACHED_OK not in gate.RUN_RUNGS
    assert len(set(gate.RUN_RUNGS)) == len(gate.RUN_RUNGS) == 10


def test_the_sound_record_is_the_only_one_that_skips() -> None:
    """The positive control for the pure ladder."""
    decision = _decide(_sound_record(Path("/s/cloude.db")),
                       db_path=Path("/s/cloude.db"))
    assert decision.skip_pragma is True
    assert decision.rung == gate.SKIP_CACHED_OK


@pytest.mark.parametrize(
    ("changes", "expected_rung"),
    [
        ({"enabled": False}, gate.RUN_CHECKER_DISABLED),
        ({"status": "failed"}, gate.RUN_VERDICT_FAILED),
        ({"status": "cancelled"}, gate.RUN_VERDICT_CANNOT_DETERMINE),
        ({"status": "cannot_determine"}, gate.RUN_VERDICT_CANNOT_DETERMINE),
        ({"finished_at": "not a date"}, gate.RUN_FRESHNESS_CANNOT_DETERMINE),
        ({"db_path": "/elsewhere/cloude.db"}, gate.RUN_DB_PATH_MISMATCH),
        ({"install_id": None}, gate.RUN_INSTALL_ID_UNRECORDED),
        ({"install_id": ""}, gate.RUN_INSTALL_ID_UNRECORDED),
        ({"install_id": "other"}, gate.RUN_INSTALL_ID_MISMATCH),
        ({"live_install_id": None}, gate.RUN_INSTALL_ID_MISMATCH),
        ({"db_size_bytes": None}, gate.RUN_DB_SHRANK),
        ({"db_size_bytes": 5000}, gate.RUN_DB_SHRANK),
        ({"live_size_bytes": None}, gate.RUN_DB_SHRANK),
        ({"live_size_bytes": 999}, gate.RUN_DB_SHRANK),
    ],
)
def test_each_departure_from_sound_refuses(
    changes: Dict[str, Any], expected_rung: str,
) -> None:
    """One field wrong is enough; every rung refuses and says which."""
    db_path = Path("/s/cloude.db")
    record = _sound_record(db_path)
    over: Dict[str, Any] = {"db_path": db_path}
    for key, value in changes.items():
        if key in {"enabled", "live_install_id", "live_size_bytes"}:
            over[key] = value
        else:
            record[key] = value
    decision = _decide(record, **over)
    assert decision.skip_pragma is False
    assert decision.rung == expected_rung
    assert decision.reason


def test_a_missing_record_refuses() -> None:
    """No artifact at all is never_ran, never a clean bill of health."""
    decision = _decide(None)
    assert decision.skip_pragma is False
    assert decision.rung == gate.RUN_NEVER_RAN


def test_a_stale_record_refuses() -> None:
    """Outside two intervals the verdict no longer stands for the file."""
    db_path = Path("/s/cloude.db")
    record = _sound_record(db_path)
    record["finished_at"] = _stamp(4 * 24 * 60 * 60)
    decision = _decide(record, db_path=db_path)
    assert decision.skip_pragma is False
    assert decision.rung == gate.RUN_STALE


def test_the_freshness_window_is_two_check_intervals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The window is DERIVED from the schedule, never picked here.

    Shorten the interval and the window follows, which is what keeps a
    boot gate and GET /api/v1/version from disagreeing about whether the
    database has been verified.
    """
    monkeypatch.setenv("CLOUDE_DB_INTEGRITY_CHECK_INTERVAL", "3600")
    db_path = Path("/s/cloude.db")
    record = _sound_record(db_path)
    record["finished_at"] = _stamp(3 * 3600)
    assert _decide(record, db_path=db_path).rung == gate.RUN_STALE
    record["finished_at"] = _stamp(1800)
    assert _decide(record, db_path=db_path).skip_pragma is True


# ---------------------------------------------------------------------------
# What a boot-run check leaves behind
# ---------------------------------------------------------------------------


def test_a_boot_run_check_publishes_its_verdict(
    tmp_path: Path, checker_on: None,
) -> None:
    """A check boot was obliged to run is a real completed check.

    Without publishing, the next boot would walk a file that had been
    verified moments earlier, and the fix would never take effect on a
    machine that restarts more often than the daily schedule fires.
    """
    state_dir = _built_state_dir(tmp_path)
    record = read_verdict(state_dir)

    assert record is not None
    assert record["status"] == "ok"
    assert record["source"] == "boot"
    assert record["install_id"]
    assert isinstance(record["db_size_bytes"], int)


def test_a_fresh_install_takes_two_boots_to_bind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, checker_on: None,
) -> None:
    """A brand new database cannot bind its own first verdict, and says so.

    The gate runs BEFORE the schema exists, so the first boot of a fresh
    install has no ``meta`` table to read an install_id out of and
    publishes None. The second boot refuses on that, re-measures and
    binds; the third skips. That warm-up is the honest cost of refusing
    to trust an unidentified verdict, and on a fresh file the walk is
    instant anyway.
    """
    state_dir = tmp_path / "state"
    state_dir.mkdir()

    assert ensure_db_migrated(state_dir, 4, APP_VERSION).status == STATUS_OK
    first = read_verdict(state_dir)
    assert first is not None and first["install_id"] is None

    assert ensure_db_migrated(state_dir, 4, APP_VERSION).status == STATUS_OK
    second = read_verdict(state_dir)
    assert second is not None and second["install_id"]

    calls = _walk_counter(monkeypatch)
    assert ensure_db_migrated(state_dir, 4, APP_VERSION).status == STATUS_OK
    assert calls == [], "the third boot should have stood on the second's work"


def test_the_published_install_id_is_the_databases_own(
    tmp_path: Path, checker_on: None,
) -> None:
    """The recorded identity has to come from the file, not from a guess."""
    state_dir = _built_state_dir(tmp_path)
    record = read_verdict(state_dir)
    assert record is not None
    with connect(db_path_for(state_dir), create=False) as conn:
        live = gate.live_install_id(conn)
    assert live and record["install_id"] == live
