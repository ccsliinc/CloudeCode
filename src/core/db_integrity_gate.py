"""The boot gate: may this start trust the cached integrity verdict?

WHY THIS MODULE EXISTS. ``ensure_db_migrated`` ran
``PRAGMA integrity_check`` unconditionally, before the schema-version
gate, on every single start. Measured on the owner's 5.4 GB cloude.db on
2026-09-11: 51.8 seconds of a 55 second startup window, after which the
entire remaining lifespan took 200 ms. The port is shut for all of it.
Meanwhile the daily background checker in ``src/core/db_integrity.py``
had walked the same file six hours earlier, in 19.767 s, and written
``ok`` to ``<state_dir>/db-integrity/latest.json``, and boot ignored it.

This is the same move ``src/core/db_health.py`` already made when the
pragma came off ``GET /api/v1/version``, and it is made the same way: the
expensive walk stays a MAINTENANCE OPERATION on a schedule, and the
cheap path reads the verdict it produced.

THE ONE RULE. ONLY A POSITIVE, FRESH, ``ok`` VERDICT TAKEN ON THIS
DATABASE MAY SKIP THE PRAGMA. Everything else runs it. There is no rung
that trades a little safety for a little speed, because the two sides of
that trade are not comparable: skipping wrongly means migrating a corrupt
database or telling the user a corrupt one is sound, and running
needlessly costs 20 to 50 seconds of a startup that already happened.
Every refusal is therefore free, and the ladder is written to refuse on
anything it cannot positively establish.

WHAT "FRESH" MEANS, AND WHY THE NUMBER IS NOT PICKED HERE. The window is
:func:`db_integrity.resolve_stale_after_seconds`, two check intervals, 48
hours at the default daily cadence, derived from the interval rather than
hardcoded so shortening the schedule automatically shortens the window.
More than reuse of a number, this module reuses the REDUCTION:
:func:`db_integrity_status.classify_record` is the single definition of
"has this database been verified", and ``GET /api/v1/version`` calls it
too. A boot gate with its own window could skip the check while the
status block a user is looking at says ``cannot_determine``, and neither
surface could explain the disagreement.

WHICH DATABASE THE VERDICT DESCRIBES. The artifact used to record only
``db_path``, which is derived from the state directory on both sides and
therefore always matches and proves nearly nothing: a restored file lands
at the same path. It now also records ``meta.install_id`` and the file's
size, following ``src/core/corpus_ingest_scan.py``, which already
invalidates its own cache on a changed ``install_id`` ("this is a
different or restored database") and on a counter going backwards. So the
gate checks three identity facts, and refuses on any of them:

  * ``db_path``       - the verdict is for the file being opened
  * ``install_id``    - the same logical install, not a different one
                        dropped in at that path. An artifact written
                        before this field existed carries None and is
                        REFUSED, which is why the first boot after this
                        ships still runs the pragma.
  * ``db_size_bytes`` - the file is not SMALLER than when it was
                        verified. SQLite does not shrink in normal
                        operation, so a smaller file has been replaced,
                        restored from an older backup, truncated or
                        VACUUMed. A VACUUM is the one false positive and
                        it costs exactly one slow boot.

WHAT THIS CANNOT DETECT, SAID PLAINLY RATHER THAN IMPLIED AWAY. An
in-place restore of a SAME-SIZE-OR-LARGER backup of the SAME install is
invisible to all three facts, and so is silent bit rot between the check
and this boot. An unclean shutdown is not detectable either: in WAL mode
a ``-wal`` file is present whenever a connection is open and routinely
survives a clean exit, and this app is a menubar app that is killed
often, so any crash heuristic built on it would refuse constantly or
never. For all three, the freshness window is the only control, and it is
the same control the daily check has always relied on.

A RECORDED FAILURE RUNS THE LIVE PRAGMA; IT DOES NOT SHORT-CIRCUIT. The
alternative - returning the degraded state straight from the cached
complaint - looks stricter and is worse: it makes a stale failure
permanent, so a user who restored a verified backup after a corruption
would boot read-only forever, with a cached verdict outranking a live
one. Running the pragma cannot be softer than today's behaviour, because
it IS today's behaviour: a genuinely corrupt file produces exactly the
same DatastoreState it always did.
"""

from __future__ import annotations

import sqlite3
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, NamedTuple, Optional

import structlog

from src.core.corpus_ingest_state import (
    FRESHNESS_CANNOT_DETERMINE,
    FRESHNESS_NEVER_RAN,
    FRESHNESS_STALE,
)
from src.core.db import db_path_for, get_meta, integrity_check
from src.core.db_integrity import (
    RUN_FAILED,
    RUN_OK,
    SOURCE_BOOT,
    db_size_bytes,
    integrity_check_enabled,
    publish_run,
    read_verdict,
)
from src.core.db_integrity_status import (
    VERDICT_FAILED,
    VERDICT_OK,
    VerdictReading,
    classify_record,
)
from src.core.db_models import META_INSTALL_ID

logger = structlog.get_logger()

#: The verdict string a sound database produces. SQLite's own word, kept
#: here so the caller compares against one constant rather than a literal.
PRAGMA_OK = "ok"

#: Every rung that REFUSES to trust the cache and runs the pragma. They
#: are named rather than collapsed to a bool so the log line at boot says
#: which one fired, which is the only way to tell a genuine skip from a
#: fast boot that got lucky on a warm page cache.
RUN_CHECKER_DISABLED = "checker_disabled"
RUN_NEVER_RAN = "never_ran"
RUN_FRESHNESS_CANNOT_DETERMINE = "freshness_cannot_determine"
RUN_STALE = "stale"
RUN_VERDICT_FAILED = "verdict_failed"
RUN_VERDICT_CANNOT_DETERMINE = "verdict_cannot_determine"
RUN_DB_PATH_MISMATCH = "db_path_mismatch"
RUN_INSTALL_ID_UNRECORDED = "install_id_unrecorded"
RUN_INSTALL_ID_MISMATCH = "install_id_mismatch"
RUN_DB_SHRANK = "db_smaller_than_verified"

#: The ONE rung that skips.
SKIP_CACHED_OK = "cached_ok_current"

#: Every rung above, as one tuple, so a test can assert the ladder has not
#: quietly grown a new way to skip.
RUN_RUNGS = (
    RUN_CHECKER_DISABLED,
    RUN_NEVER_RAN,
    RUN_FRESHNESS_CANNOT_DETERMINE,
    RUN_STALE,
    RUN_VERDICT_FAILED,
    RUN_VERDICT_CANNOT_DETERMINE,
    RUN_DB_PATH_MISMATCH,
    RUN_INSTALL_ID_UNRECORDED,
    RUN_INSTALL_ID_MISMATCH,
    RUN_DB_SHRANK,
)


class BootIntegrityDecision(NamedTuple):
    """Whether the cached verdict may stand in for a live pragma.

    Description: the pure ladder's answer. ``skip_pragma`` is True on
      exactly one rung; every other value of ``rung`` is a refusal and
      carries ``skip_pragma`` False.
    """

    skip_pragma: bool
    rung: str
    reason: str


class BootIntegrityResult(NamedTuple):
    """What boot may now say about the database's integrity.

    Description: ``verdict`` is in the SAME vocabulary
      :func:`src.core.db.integrity_check` returns - the literal string
      "ok", or the pragma's complaint - so the caller's existing
      ``if verdict != "ok"`` branch is unchanged whether the answer came
      from a live walk or from the cache.
    """

    verdict: str
    skipped: bool
    rung: str
    reason: str
    duration_seconds: float


def resolve_boot_integrity(
    *,
    enabled: bool,
    record: Optional[Dict[str, Any]],
    reading: VerdictReading,
    db_path: Path,
    live_install_id: Optional[str],
    live_size_bytes: Optional[int],
) -> BootIntegrityDecision:
    """Decide whether the cached verdict may skip the boot pragma.

    Description: the PURE ladder, with no database, no filesystem and no
      clock in it, so every rung is reachable from a test without
      arranging a real 5 GB file. Reads top to bottom and returns on the
      first rung that answers; a recorded FAILURE is tested first because
      that is the precedence :func:`db_integrity_status.classify_record`
      already applies, a known failure not becoming unknown by ageing.
    Inputs: enabled (bool - is the background checker switched on, i.e.
      is anything maintaining this cache), record (dict | None - the
      artifact as read, or None when it is absent, unreadable, malformed
      or truncated), reading (VerdictReading - the shared reduction of
      that same record, which must be the SAME record object or the two
      can describe different runs), db_path (Path - the database being
      opened), live_install_id (str | None - meta.install_id read from
      the open connection, None when it could not be read),
      live_size_bytes (int | None - the file's size now, None when the
      stat failed).
    Output: BootIntegrityDecision.
    Example: resolve_boot_integrity(enabled=False, record=None,
      reading=classify_record(None), db_path=Path("/s/cloude.db"),
      live_install_id=None, live_size_bytes=None).skip_pragma -> False
    """
    if not enabled:
        return BootIntegrityDecision(
            False, RUN_CHECKER_DISABLED,
            "the background integrity checker is switched off, so nothing "
            "refreshes the cached verdict and it may not stand in for a "
            "live check",
        )
    if reading.verdict == VERDICT_FAILED:
        return BootIntegrityDecision(
            False, RUN_VERDICT_FAILED,
            "the last recorded integrity check FAILED, so this start "
            "re-measures rather than trusting either the failure or its age",
        )
    if record is None or reading.freshness == FRESHNESS_NEVER_RAN:
        return BootIntegrityDecision(
            False, RUN_NEVER_RAN,
            "no readable integrity verdict has ever been published in this "
            "state directory; never having looked is not evidence of "
            "soundness",
        )
    if reading.freshness == FRESHNESS_CANNOT_DETERMINE:
        return BootIntegrityDecision(
            False, RUN_FRESHNESS_CANNOT_DETERMINE,
            f"the cached verdict's age could not be measured: {reading.reason}",
        )
    if reading.freshness == FRESHNESS_STALE:
        return BootIntegrityDecision(
            False, RUN_STALE,
            f"the cached verdict is outside its freshness window: "
            f"{reading.reason}",
        )
    if reading.verdict != VERDICT_OK:
        return BootIntegrityDecision(
            False, RUN_VERDICT_CANNOT_DETERMINE,
            f"the cached record is not a verdict on the database: "
            f"{reading.reason}",
        )

    recorded_path = record.get("db_path")
    if str(recorded_path or "") != str(db_path):
        return BootIntegrityDecision(
            False, RUN_DB_PATH_MISMATCH,
            f"the cached verdict was taken on {recorded_path!r}, not on "
            f"{str(db_path)!r}",
        )

    recorded_install = record.get("install_id")
    if not recorded_install:
        return BootIntegrityDecision(
            False, RUN_INSTALL_ID_UNRECORDED,
            "the cached verdict does not record which install it was taken "
            "on, so it cannot be shown to describe this database",
        )
    if not live_install_id or str(recorded_install) != str(live_install_id):
        return BootIntegrityDecision(
            False, RUN_INSTALL_ID_MISMATCH,
            "the cached verdict was taken on a different install, or this "
            "database's install_id could not be read",
        )

    recorded_size = record.get("db_size_bytes")
    if not isinstance(recorded_size, int) or isinstance(recorded_size, bool):
        return BootIntegrityDecision(
            False, RUN_DB_SHRANK,
            "the cached verdict does not record the size of the file it "
            "verified, so a replacement could not be ruled out",
        )
    if live_size_bytes is None or live_size_bytes < recorded_size:
        return BootIntegrityDecision(
            False, RUN_DB_SHRANK,
            f"the database is now {live_size_bytes} bytes against "
            f"{recorded_size} when it was verified; SQLite does not shrink "
            "in normal operation, so this file has been replaced, restored, "
            "truncated or VACUUMed",
        )

    return BootIntegrityDecision(
        True, SKIP_CACHED_OK,
        f"a full integrity check on this database returned ok and is still "
        f"current: {reading.reason}",
    )


def live_install_id(conn: sqlite3.Connection) -> Optional[str]:
    """Read meta.install_id off an open connection, never raising.

    Description: one indexed SELECT against a table with a handful of
      rows. None means "could not be established", which the ladder
      treats as a refusal, never as agreement: a pre-v1 database has no
      meta table at all and ``get_meta`` answers None for it too.
    Inputs: conn (sqlite3.Connection) - the connection boot already holds.
    Output: str | None.
    Example: live_install_id(sqlite3.connect(":memory:")) -> None
    """
    try:
        return get_meta(conn, META_INSTALL_ID)
    except sqlite3.Error as exc:
        # Swallowed on purpose: an unreadable install_id must degrade to a
        # refusal, not take boot down. The refusal is the safe direction
        # and it costs one pragma.
        logger.warning("db_boot_install_id_unreadable", error=str(exc))
        return None


def boot_integrity_verdict(
    state_dir: Path,
    conn: sqlite3.Connection,
    *,
    now: Optional[datetime] = None,
) -> BootIntegrityResult:
    """Answer boot's integrity question, from the cache when it may.

    Description: the seam. Reads the artifact ONCE and hands that one
      record to both the shared reduction and the identity rungs, so the
      background checker writing between two reads can never pair one
      run's verdict with another run's identity. On a refusal it runs the
      real pragma on the connection it was given and PUBLISHES the result,
      because a check boot was obliged to run is a real completed check
      and a record it withheld would make the next boot walk a file
      verified moments earlier.
    Inputs: state_dir (Path - Settings.get_state_dir()), conn
      (sqlite3.Connection - the open database, already connected by the
      caller), now (datetime | None - injected by tests so staleness can
      be exercised without sleeping).
    Output: BootIntegrityResult, whose ``verdict`` is "ok" or the pragma's
      complaint.
    Example: boot_integrity_verdict(state_dir, conn).verdict -> 'ok'
    """
    db_path = db_path_for(state_dir)
    record = read_verdict(state_dir)
    reading = classify_record(record, now=now)
    install = live_install_id(conn)
    decision = resolve_boot_integrity(
        enabled=integrity_check_enabled(),
        record=record,
        reading=reading,
        db_path=db_path,
        live_install_id=install,
        live_size_bytes=db_size_bytes(db_path),
    )
    if decision.skip_pragma:
        logger.info(
            "db_boot_integrity_skipped",
            rung=decision.rung,
            checked_at=(record or {}).get("finished_at"),
            age_seconds=(
                None if reading.age_seconds is None
                else round(reading.age_seconds, 1)
            ),
            reason=decision.reason,
        )
        return BootIntegrityResult(
            verdict=PRAGMA_OK,
            skipped=True,
            rung=decision.rung,
            reason=decision.reason,
            duration_seconds=0.0,
        )

    started = time.monotonic()
    verdict = integrity_check(conn)
    elapsed = round(time.monotonic() - started, 3)
    publish_run(
        state_dir,
        RUN_OK if verdict == PRAGMA_OK else RUN_FAILED,
        db_path,
        started,
        None if verdict == PRAGMA_OK else verdict,
        install_id=install,
        source=SOURCE_BOOT,
    )
    logger.info(
        "db_boot_integrity_ran",
        rung=decision.rung,
        verdict_ok=verdict == PRAGMA_OK,
        duration_seconds=elapsed,
        reason=decision.reason,
    )
    return BootIntegrityResult(
        verdict=verdict,
        skipped=False,
        rung=decision.rung,
        reason=decision.reason,
        duration_seconds=elapsed,
    )


__all__ = [
    "PRAGMA_OK",
    "RUN_CHECKER_DISABLED",
    "RUN_DB_PATH_MISMATCH",
    "RUN_DB_SHRANK",
    "RUN_FRESHNESS_CANNOT_DETERMINE",
    "RUN_INSTALL_ID_MISMATCH",
    "RUN_INSTALL_ID_UNRECORDED",
    "RUN_NEVER_RAN",
    "RUN_RUNGS",
    "RUN_STALE",
    "RUN_VERDICT_CANNOT_DETERMINE",
    "RUN_VERDICT_FAILED",
    "SKIP_CACHED_OK",
    "BootIntegrityDecision",
    "BootIntegrityResult",
    "boot_integrity_verdict",
    "live_install_id",
    "resolve_boot_integrity",
]
