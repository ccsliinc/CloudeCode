"""The one function in this project that writes into ``~/.claude/projects``.

``~/.claude/projects`` belongs to a RUNNING tool. claude may be appending
to a file in there while this code executes, and every transcript in it
is the only copy of a conversation. So this module is built around three
refusals and one durability pattern, and none of them is optional.

1. THE HOME WRITE GUARD RUNS FIRST, BEFORE ANYTHING IS OPENED.
   :func:`src.core.test_write_guard.assert_test_write_allowed` is inert in
   production and, during a pytest run, refuses any destination outside a
   temp root - including one it cannot place, because "I could not work
   out where this write would land" is the exact state the defect it was
   written for hid in. A test that reaches this writer with a real
   ``~/.claude`` path is stopped here rather than eating the developer's
   corpus. It is checked on the TARGET and again on the TEMP FILE: they
   share a directory today, and a future change that moves the temp
   elsewhere must not slip past a check that only ever saw the target.

2. AN EXISTING FILE IS NEVER REPLACED WITHOUT AN EXPLICIT, SEPARATE
   OPT-IN, and the caller has to pass ``allow_overwrite`` as well as
   having cleared :func:`..transcript_restore_target.resolve_target`.
   Two gates for one irreversible act, deliberately. THE RE-CHECK HERE
   NARROWS A RACE AND DOES NOT CLOSE IT: between this stat and the
   ``os.replace`` a live claude could create the file, and a rename
   cannot be made conditional on the destination being absent on macOS.
   Saying so is better than a comment claiming a guarantee the syscall
   does not provide. The case this feature exists for - a conversation
   whose transcript is gone - has no live writer by construction.

3. THE OLD BYTES ARE BACKED UP BEFORE THEY ARE LOST. On the overwrite
   path a ``.bak`` of the PRE-WRITE bytes is written and fsync'd FIRST,
   which is the ordering ``Settings.update_settings_config()`` and
   :mod:`src.core.config_writer` established here.

DURABILITY: temp file in the SAME directory (so ``os.replace`` is a
rename within one filesystem and therefore atomic), ``flush``, ``fsync``
the file, ``os.replace``, then ``fsync`` THE DIRECTORY. The last step is
the one that usually gets left out: ``os.replace`` makes the new name
appear atomically, but the directory entry is not durable until the
directory itself is synced, so a crash in between can leave neither name.

AND THE WRITE IS VERIFIED BY READING IT BACK. A writer that reports
success from the absence of an exception is reporting that no error was
raised, not that the right bytes are on disk. This one re-opens the file
it just created and re-hashes it.
"""

from __future__ import annotations

import hashlib
import os
import uuid as uuid_module
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import structlog

from src.core.test_write_guard import OutsideTempWriteError, assert_test_write_allowed
from src.core.transcript_restore_outcomes import (
    REFUSED_BY_TEST_GUARD,
    VERIFY_AFTER_WRITE_FAILED,
    WRITE_FAILED,
    WRITTEN,
)

logger = structlog.get_logger()

#: Suffix for the pre-write copy taken on the overwrite path. Same
#: convention as ``config.json.bak``.
BACKUP_SUFFIX: str = ".bak"


@dataclass(frozen=True)
class WriteResult:
    """What the write did, and the evidence for it.

    Description: ``outcome`` is one of ALL_WRITE_OUTCOMES.
      ``verified_sha256`` is read back OFF DISK, not carried over from
      the caller, so a WRITTEN verdict rests on a comparison that
      actually ran.
    Inputs: constructed by :func:`write_transcript`.
    Output: n/a (data holder).
    """

    outcome: str
    path: Optional[Path] = None
    bytes_written: int = 0
    verified_sha256: str = ""
    expected_sha256: str = ""
    backup_path: Optional[Path] = None
    detail: str = ""


def _fsync_dir(directory: Path) -> None:
    """Flush a directory entry to stable storage.

    Description: makes the rename performed by ``os.replace`` durable. A
      platform that refuses to open a directory for reading raises
      ``OSError``; that is logged and swallowed DELIBERATELY, because the
      bytes are already in place by then and failing the whole write over
      a weaker durability guarantee would be the worse outcome.
    Inputs: directory (Path).
    Output: None.
    Example: _fsync_dir(Path('/tmp'))
    """
    fd = None
    try:
        fd = os.open(str(directory), os.O_RDONLY)
        os.fsync(fd)
    except OSError as exc:
        logger.debug(
            "transcript_restore_dir_fsync_failed", directory=str(directory), error=str(exc)
        )
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                # The descriptor is going away with the process anyway.
                pass


def _write_backup(target: Path) -> Optional[Path]:
    """Copy the pre-write bytes to ``<target>.bak`` and fsync them.

    Description: the overwrite path's only protection for bytes that
      are about to stop existing, so it runs BEFORE the temp file is
      opened. Returns None when the target does not exist, which is the
      ordinary create case and needs no backup.
    Inputs: target (Path).
    Output: Path | None - where the backup landed.
    Raises: OSError - the backup could not be taken. The caller must
      treat that as a refusal to proceed: losing the old bytes is the
      failure this exists to prevent.
    Example: _write_backup(Path('/tmp/a.jsonl'))
    """
    try:
        previous = target.read_bytes()
    except FileNotFoundError:
        return None
    backup = target.with_name(target.name + BACKUP_SUFFIX)
    assert_test_write_allowed(backup)
    with open(backup, "wb") as handle:
        handle.write(previous)
        handle.flush()
        os.fsync(handle.fileno())
    _fsync_dir(backup.parent)
    return backup


def write_transcript(
    target: Path,
    data: bytes,
    expected_sha256: str,
    *,
    allow_overwrite: bool = False,
    create_dirs: bool = False,
) -> WriteResult:
    """Put a reconstructed transcript on disk, atomically and verifiably.

    Description: the whole pattern described in the module docstring -
      guard, refuse-if-present, backup, temp file, fsync, replace, fsync
      the directory, read back and re-hash.
    Inputs: target (Path) - absolute destination, already cleared by
      :func:`..transcript_restore_target.resolve_target`. data (bytes) -
      the reconstruction. expected_sha256 (str) - what the archive says
      those bytes hash to; the read-back is compared against it.
      allow_overwrite (bool) - the second of the two gates in front of
      replacing a live file. create_dirs (bool) - create a missing
      project directory.
    Output: WriteResult.
    Example: write_transcript(tmp / 'a.jsonl', b'{}\\n', sha).outcome
      # 'written'
    """
    try:
        assert_test_write_allowed(target)
    except OutsideTempWriteError as exc:
        return WriteResult(REFUSED_BY_TEST_GUARD, path=target, detail=str(exc))

    if target.exists() and not allow_overwrite:
        return WriteResult(
            WRITE_FAILED,
            path=target,
            detail=(
                f"{target} exists and allow_overwrite is False. Refusing: the "
                "file may be a live conversation claude is appending to."
            ),
        )

    tmp_path = target.with_name(
        f"{target.name}.{os.getpid()}.{uuid_module.uuid4().hex[:8]}.tmp"
    )
    try:
        assert_test_write_allowed(tmp_path)
    except OutsideTempWriteError as exc:
        return WriteResult(REFUSED_BY_TEST_GUARD, path=tmp_path, detail=str(exc))

    backup: Optional[Path] = None
    try:
        if create_dirs:
            target.parent.mkdir(parents=True, exist_ok=True)
        if allow_overwrite:
            backup = _write_backup(target)
        with open(tmp_path, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, target)
        _fsync_dir(target.parent)
    except OSError as exc:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            # Nothing to clean up: the failure was before the temp file
            # existed, or os.replace already consumed it.
            pass
        logger.warning(
            "transcript_restore_write_failed", target=str(target), error=str(exc)
        )
        return WriteResult(
            WRITE_FAILED, path=target, backup_path=backup, detail=str(exc)
        )

    try:
        landed = target.read_bytes()
    except OSError as exc:
        return WriteResult(
            VERIFY_AFTER_WRITE_FAILED,
            path=target,
            bytes_written=len(data),
            expected_sha256=expected_sha256,
            backup_path=backup,
            detail=f"wrote {target} but could not read it back ({exc})",
        )

    digest = hashlib.sha256(landed).hexdigest()
    if digest != expected_sha256 or len(landed) != len(data):
        return WriteResult(
            VERIFY_AFTER_WRITE_FAILED,
            path=target,
            bytes_written=len(landed),
            verified_sha256=digest,
            expected_sha256=expected_sha256,
            backup_path=backup,
            detail=(
                f"{target} is on disk and is NOT what was meant to be written "
                f"({len(landed)} bytes, sha256 {digest})"
            ),
        )

    logger.info(
        "transcript_restore_written",
        target=str(target),
        bytes_written=len(landed),
        sha256=digest,
        overwrote=backup is not None,
    )
    return WriteResult(
        WRITTEN,
        path=target,
        bytes_written=len(landed),
        verified_sha256=digest,
        expected_sha256=expected_sha256,
        backup_path=backup,
    )
