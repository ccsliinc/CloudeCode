"""The drain's progress artifact, and the two ways it misled a reader.

BOTH TESTS HERE ARE REGRESSIONS ON REAL INCIDENTS, 2026-09-14.

  1. A deliberate SIGTERM pause was published as ``status: failed``,
     because the script tested ``report.status != STATUS_OK`` before it
     tested the cancel flag and a cancelled pass is not OK. A reader
     cannot tell an asked-for stop from a crash, and this one was
     reported upward as a crash.

  2. The ETA was computed in ARCHIVES per second over a queue ordered
     ``ingested_at DESC``. The newest transcripts are much the largest,
     so the head of that queue is the worst possible sample: measured at
     784 archives drained, the done ones averaged 2.218 MB of raw
     transcript against 0.502 MB for the 18,777 left, a 4.42x bias. The
     archives-per-second ETA said 9.2 hours while the byte rate said
     2.4, and the same arithmetic applied to disk growth produced a
     false alarm about filling the boot volume.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_drain_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_drain_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core import message_drain_liveness as liveness


def test_the_eta_is_taken_in_bytes_not_in_archives(tmp_path: Path) -> None:
    """THE SIZE-SORTED QUEUE. Counting units that differ in size lies.

    The real shape, with the real ratio: a tenth of the archives are
    done and they carried a quarter of the bytes. An ETA built on the
    archive count would say there is 9x the elapsed time left; the bytes
    say 3x. Only one of those is proportional to the work.
    """
    record = liveness.publish(
        tmp_path, liveness.STATUS_RUNNING,
        done=1_000, pending=9_000, elapsed_seconds=1_000.0,
        bytes_done=2_500_000_000, bytes_pending=7_500_000_000,
    )

    assert record["mb_per_second"] == 2.5
    # 7.5e9 bytes at 2.5e6 bytes/s = 3000s. The archive count would have
    # given 9000s, which is the defect.
    assert record["eta_seconds"] == 3_000
    # The archive rate is still REPORTED, because it is a true statement
    # about throughput. It is simply not what the ETA may rest on.
    assert record["archives_per_second"] == 1.0


def test_no_bytes_measured_means_no_eta_rather_than_a_guess(
    tmp_path: Path,
) -> None:
    """THE NEGATIVE CONTROL for the test above.

    An implementation that silently fell back to the archive count when
    no byte figure was passed would satisfy the first test perfectly and
    reintroduce the whole defect on the path that has no bytes yet. Not
    having measured the work is not a licence to estimate it.
    """
    record = liveness.publish(
        tmp_path, liveness.STATUS_RUNNING,
        done=1_000, pending=9_000, elapsed_seconds=1_000.0,
    )

    assert record["archives_per_second"] == 1.0
    assert record["mb_per_second"] is None
    assert record["eta_seconds"] is None


def test_an_asked_for_stop_is_not_a_failure(tmp_path: Path) -> None:
    """A pause and a crash are different facts and get different words."""
    stopped = liveness.publish(
        tmp_path, liveness.STATUS_INTERRUPTED, done=784, pending=18_777,
        elapsed_seconds=1_314.9, bytes_done=1_750_265_684,
        bytes_pending=9_430_751_064,
        detail="stopped at a file boundary; re-run to resume",
    )
    assert stopped["status"] == liveness.STATUS_INTERRUPTED
    assert liveness.read_status(tmp_path)["status"] == liveness.STATUS_INTERRUPTED


def test_the_script_tests_the_interrupt_before_the_failure() -> None:
    """The ORDER in the drain script, pinned in the file itself.

    The bug was not in the liveness module: it was that the caller's
    `report.status != STATUS_OK` branch sat above any check of the
    cancel flag, so a cancelled pass fell into it. Asserting the order
    textually is crude, and it is what actually failed - a test of
    publish() alone passes happily while the script still mislabels
    every pause.
    """
    source = (ROOT / "scripts" / "project_archive_to_message_model.py").read_text()
    cancel_branch = source.index("if cancel.is_set():\n            break")
    failure_branch = source.index("if report.status != STATUS_OK:")
    assert cancel_branch < failure_branch, (
        "the failure branch is above the interrupt branch again, so a "
        "deliberate SIGTERM will be published as a crash"
    )
