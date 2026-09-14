"""Byte-exact export out of ``transcript_archives``, and the id space it uses.

TWO STORES, TWO JOBS, AND THIS MODULE SERVES THE OTHER ONE.
:mod:`src.core.archive_export` reassembles a transcript from the PARSED
message model (``message_transcripts`` plus ``message_bodies``), which is
what makes that surface searchable, indexable and streamable in bounded
memory. This module hands back the ORIGINAL FILE, byte for byte, out of
``transcript_archives``. Neither is a replacement for the other and
neither may be repointed at the other's table: the parsed model cannot
promise the original bytes, and the archive cannot answer a query about a
message block.

THE ID SPACES ARE THE TRAP, AND THE FIX IS STRUCTURAL.
``message_transcripts.id`` and ``transcript_archives.id`` are BOTH
``INTEGER PRIMARY KEY`` and, since the archive split, both live in
``cloude-archive.db``. Measured 2026-09-14: archive ids run 1..23475
contiguously, and ``message_transcripts`` will number from 1 too once the
corpus drain lands. So an integer is ambiguous BY CONSTRUCTION, and the
failure it produces is a WRONG 200 - a real transcript that is the wrong
transcript - which is strictly worse than the missing surface this module
was written to add.

So the archive's public id is ``archive_uuid``: ``TEXT NOT NULL UNIQUE``,
canonical 36-character form on all 23,475 live rows (measured, whole
population, not a sample). A uuid cannot be an integer primary key, so a
caller holding an archive identity CANNOT accidentally address the
message model with it, and vice versa. The wrong id becomes
unrepresentable rather than merely detected.

An integer is still ACCEPTED, and deliberately never guessed at:
:func:`classify_archive_ref` names it ``integer_id`` and the route turns
that into a refusal that says which space the value looks like it came
from and where to exchange it. A caller that legitimately holds an
archive rowid (the dedupe modules, ``verify_against_source``) asks for the
exchange explicitly through :func:`archive_uuid_for_rowid`.

THE REFUSAL RULE, FROM docs/transcript-archive-integrity.md.
Reconstruct through :func:`src.core.transcript_archive.export_archive` and
NEVER read ``content_gzip`` directly. 3,924 of 23,475 rows (16.7 percent,
measured) hold an 8-byte ``zlib.compress(b"", 9)`` sentinel because their
bytes live forward along ``superseded_by_archive_id``; their
``content_sha256`` and ``raw_byte_length`` deliberately still describe
the row's own full content. Chains reach depth 267. Those rows are NOT
corrupt - all 23,475 reconstruct to their recorded hash AND length.

Then check BOTH halves before a byte is handed over::

    ok = (sha256(recon).hexdigest() == row["content_sha256"]
          and len(recon) == row["raw_byte_length"])

Both are load-bearing: length alone misses a flipped bit, hash alone
passes an empty reconstruction against a genuinely-empty row (there are
17 such rows, whose true content was empty and whose sentinel therefore
hashes correct by coincidence).

A MISSING SOURCE FILE IS NOT A REFUSAL CONDITION. 2,524 rows have no
surviving file in ``~/.claude/projects`` and every one of them is sound;
holding the only copy is the archive doing its job. Nothing in this
module opens the filesystem, which is the surest way never to make that
mistake.

MEMORY IS O(raw_byte_length) AND THAT IS SAID OUT LOUD.
``export_archive`` returns ``bytes``, so a reconstruction is fully
resident. The largest transcript in the corpus is 244,117,661 bytes and
reconstructs in 416.5 ms (measured, live archive, read-only). A genuinely
constant-memory export would need an incremental chain-aware
decompressor, which is a SECOND reconstruction path - a new thing that
can silently disagree with the one verified across all 23,475 rows. It is
not built here on purpose; the ceiling and the concurrency bound below
are what keep the cost survivable instead.
"""

from __future__ import annotations

import hashlib
import sqlite3
import uuid as uuid_module
import zlib
from typing import Any, Dict, Optional, Tuple

from src.core.transcript_archive import export_archive

# --- Reference classification --------------------------------------------

#: The value is a canonical 36-character uuid: an archive identity.
REF_ARCHIVE_UUID: str = "archive_uuid"
#: The value is all digits. Valid in BOTH id spaces, so it is never
#: resolved implicitly - it becomes a refusal naming both.
REF_INTEGER_ID: str = "integer_id"
#: Neither. Not a uuid, not an integer.
REF_MALFORMED: str = "malformed"

# --- Export outcome vocabulary -------------------------------------------

#: Reconstructed, and hash AND length both agree. The only servable one.
ARCHIVE_EXPORT_OK: str = "ok"
#: No row with that archive_uuid. A MEASUREMENT, not a failure to look.
ARCHIVE_EXPORT_NOT_FOUND: str = "not_found"
#: The row exists, but the supersession chain does not resolve - a
#: pointer to a row that is gone. Kept apart from ``not_found`` because
#: this one indicates a DEFECT in the archive, and collapsing them
#: would hide it behind a routine 404.
ARCHIVE_EXPORT_CHAIN_BROKEN: str = "chain_broken"
#: Reconstruction raised: a corrupt blob (zlib.error) or a cycle in the
#: chain (ValueError). A refusal, safe to act on.
ARCHIVE_EXPORT_RECONSTRUCTION_FAILED: str = "reconstruction_failed"
#: Reconstruction completed and disagrees with the recorded hash or the
#: recorded length. A refusal, safe to act on. Both actual values are
#: reported so the comparison can be re-run; a boolean would not allow it.
ARCHIVE_EXPORT_INTEGRITY_MISMATCH: str = "integrity_mismatch"
#: Over the caller's ceiling. NOT a statement about the content.
ARCHIVE_EXPORT_TOO_LARGE: str = "too_large"

#: 256 MiB. Covers the corpus's largest row (244,117,661 bytes, measured)
#: with headroom and refuses anything beyond it rather than letting one
#: request decide how much memory the process uses. Not a guess about
#: what is reasonable: it is the measured maximum plus a margin.
ARCHIVE_EXPORT_MAX_BYTES: int = 268435456


def classify_archive_ref(value: str) -> Tuple[str, Optional[str]]:
    """Name which id space a path value came from, without resolving it.

    Description: the whole id-space guard, in one pure function, so the
      route cannot invent a second rule. A canonical uuid is an archive
      identity; an all-digit value is ambiguous between
      ``transcript_archives.id`` and ``message_transcripts.id`` and is
      therefore NEVER resolved implicitly. ``uuid.UUID`` accepts braces,
      urn prefixes and unhyphenated forms, so the parsed value is
      compared back against its own canonical string: a 32-character hex
      run is not an archive_uuid as stored and must not be treated as one.
    Inputs: value (str) - the raw path segment.
    Output: tuple of (kind, canonical) where kind is one of
      ``REF_ARCHIVE_UUID`` / ``REF_INTEGER_ID`` / ``REF_MALFORMED`` and
      canonical is the normalised uuid string, or None for the other two.
    Example: classify_archive_ref("0001c5d3-8ace-4213-87f7-f799ec4391c4")
      -> ('archive_uuid', '0001c5d3-8ace-4213-87f7-f799ec4391c4')
    """
    text = value.strip()
    if text.isdigit():
        return REF_INTEGER_ID, None
    try:
        parsed = uuid_module.UUID(text)
    except (ValueError, AttributeError, TypeError):
        return REF_MALFORMED, None
    canonical = str(parsed)
    if canonical != text.lower():
        return REF_MALFORMED, None
    return REF_ARCHIVE_UUID, canonical


def archive_head(
    conn: sqlite3.Connection, archive_uuid: str
) -> Optional[Dict[str, Any]]:
    """Read one archive row's metadata WITHOUT reconstructing its content.

    Description: lets a caller learn ``raw_byte_length`` and decide
      whether it wants 244 MB before asking for it. One indexed lookup on
      the UNIQUE ``archive_uuid``; ``content_gzip`` is deliberately not
      selected, so this costs the same on the largest row as the smallest.
      ``superseded_by_archive_id`` is reported as ``is_superseded``
      because a client must not read a sentinel blob's
      ``compressed_byte_length`` as the row's real size.
    Inputs: conn (sqlite3.Connection, read-only). archive_uuid (str) -
      canonical form, as returned by :func:`classify_archive_ref`.
    Output: dict of the row's metadata, or None when there is no such
      row. None is a MEASUREMENT ("no row"), never a failure to look.
    Example: archive_head(conn, u)["raw_byte_length"] -> 92580
    """
    row = conn.execute(
        "SELECT id, archive_uuid, kind, source_path, content_sha256,"
        "       raw_byte_length, compressed_byte_length, line_ending,"
        "       has_trailing_newline, record_count, claude_session_uuid,"
        "       ingested_at, superseded_by_archive_id, growth_kind"
        "  FROM transcript_archives WHERE archive_uuid = ?",
        (archive_uuid,),
    ).fetchone()
    if row is None:
        return None
    return {
        "archive_id": int(row["id"]),
        "archive_uuid": str(row["archive_uuid"]),
        "kind": row["kind"],
        "source_path": row["source_path"],
        "content_sha256": str(row["content_sha256"]),
        "raw_byte_length": int(row["raw_byte_length"] or 0),
        "compressed_byte_length": int(row["compressed_byte_length"] or 0),
        "line_ending": row["line_ending"],
        "has_trailing_newline": bool(row["has_trailing_newline"]),
        "record_count": int(row["record_count"] or 0),
        "claude_session_uuid": row["claude_session_uuid"],
        "ingested_at": row["ingested_at"],
        "is_superseded": row["superseded_by_archive_id"] is not None,
        "growth_kind": row["growth_kind"],
    }


def archive_uuid_for_rowid(
    conn: sqlite3.Connection, rowid: int
) -> Optional[str]:
    """Exchange a ``transcript_archives`` integer id for its archive_uuid.

    Description: the EXPLICIT bridge out of the ambiguous integer space.
      It is never called to rescue a wrong-looking path value - that
      would be guessing which store the caller meant, which is the defect
      this module exists to prevent. It is called only when a caller
      states that the integer is an archive rowid.
    Inputs: conn (sqlite3.Connection, read-only). rowid (int).
    Output: str - the canonical archive_uuid, or None when no archive row
      carries that id (which does NOT imply the integer is meaningless;
      it may be a valid message_transcripts id).
    Example: archive_uuid_for_rowid(conn, 21961) -> '....-....'
    """
    row = conn.execute(
        "SELECT archive_uuid FROM transcript_archives WHERE id = ?",
        (int(rowid),),
    ).fetchone()
    return None if row is None else str(row["archive_uuid"])


def verified_archive_export(
    conn: sqlite3.Connection,
    archive_uuid: str,
    *,
    max_bytes: int = ARCHIVE_EXPORT_MAX_BYTES,
) -> Dict[str, Any]:
    """Reconstruct one archive row, verify it, and only then return bytes.

    Description: the single servable path, implementing the refusal rule
      from ``docs/transcript-archive-integrity.md`` verbatim. Reconstructs
      through :func:`export_archive` - which walks
      ``superseded_by_archive_id`` and is the form verified across all
      23,475 live rows - and NEVER touches ``content_gzip`` itself. Then
      compares the recorded sha256 AND the recorded length, because
      length alone misses a flipped bit and hash alone passes an empty
      reconstruction against an empty row.

      The size check runs BEFORE reconstruction, so refusing a 244 MB row
      costs one indexed metadata read rather than 416 ms and 244 MB.

      The filesystem is never consulted: a source file missing from
      ``~/.claude/projects`` is not a refusal condition and 2,524 rows are
      in exactly that state.
    Inputs: conn (sqlite3.Connection, read-only). archive_uuid (str) -
      canonical. max_bytes (int) - ceiling above which this refuses
      rather than reconstructing.
    Output: dict with ``status`` (one of the ``ARCHIVE_EXPORT_*``
      constants), ``head`` (the metadata, or None when not found),
      ``payload`` (bytes, ONLY when status is ok), ``actual_sha256``,
      ``actual_bytes`` and a human ``detail``.
    Example: verified_archive_export(conn, u)["status"] -> 'ok'
    """
    head = archive_head(conn, archive_uuid)
    if head is None:
        return _result(
            ARCHIVE_EXPORT_NOT_FOUND, None,
            f"no row in transcript_archives with archive_uuid "
            f"{archive_uuid}",
        )
    if head["raw_byte_length"] > max_bytes:
        return _result(
            ARCHIVE_EXPORT_TOO_LARGE, head,
            f"archive {archive_uuid} is {head['raw_byte_length']} bytes, "
            f"above this endpoint's {max_bytes}-byte ceiling. The ceiling "
            f"exists because a reconstruction is fully resident in memory.",
        )
    try:
        payload = export_archive(conn, head["archive_id"])
    except LookupError as exc:
        # The row itself was read a moment ago, so a LookupError here is
        # the chain pointing at a row that is gone. That is a defect in
        # the archive, not a routine missing id, and it is reported as a
        # different status so it cannot hide behind a 404.
        return _result(
            ARCHIVE_EXPORT_CHAIN_BROKEN, head,
            f"the supersession chain from archive {archive_uuid} does not "
            f"resolve: {exc}",
        )
    except (zlib.error, ValueError) as exc:
        return _result(
            ARCHIVE_EXPORT_RECONSTRUCTION_FAILED, head,
            f"archive {archive_uuid} could not be reconstructed: {exc}",
        )
    actual_sha = hashlib.sha256(payload).hexdigest()
    actual_len = len(payload)
    hash_ok = actual_sha == head["content_sha256"]
    length_ok = actual_len == head["raw_byte_length"]
    if not (hash_ok and length_ok):
        return _result(
            ARCHIVE_EXPORT_INTEGRITY_MISMATCH, head,
            f"archive {archive_uuid} reconstructed but does not match its "
            f"record (hash_ok={hash_ok}, length_ok={length_ok})",
            actual_sha256=actual_sha, actual_bytes=actual_len,
        )
    return _result(
        ARCHIVE_EXPORT_OK, head, "reconstructed and verified",
        payload=payload, actual_sha256=actual_sha, actual_bytes=actual_len,
    )


def _result(
    status: str,
    head: Optional[Dict[str, Any]],
    detail: str,
    *,
    payload: Optional[bytes] = None,
    actual_sha256: Optional[str] = None,
    actual_bytes: Optional[int] = None,
) -> Dict[str, Any]:
    """Build the uniform export record every outcome returns.

    Description: one shape for every status, so a caller never has to ask
      whether a key exists before reading it. ``payload`` is None on every
      status but ok - a refused export must not be able to leak bytes it
      declined to vouch for.
    Inputs: status (str), head (dict | None), detail (str), payload
      (bytes | None), actual_sha256 (str | None), actual_bytes (int|None).
    Output: dict with a fixed key set.
    Example: _result(ARCHIVE_EXPORT_OK, head, "ok", payload=b"x")
    """
    return {
        "status": status,
        "head": head,
        "payload": payload,
        "actual_sha256": actual_sha256,
        "actual_bytes": actual_bytes,
        "detail": detail,
    }


def message_model_not_found(transcript_id: int) -> Dict[str, Any]:
    """Build the message model's 404, naming the store and the sibling surface.

    Description: THE HONESTY FIX for
      ``/archive/transcripts/{id}/export``. That route reads
      ``message_transcripts``, and a caller holding a
      ``transcript_archives`` id gets a truthful "no such row" that tells
      them nothing about why - the two stores share a database and an
      integer id space, so the mistake is easy and invisible. The envelope
      now says which table was searched and where the byte-exact archive
      surface is. It does NOT resolve the integer against
      ``transcript_archives``: this route's job is the parsed model, and
      quietly answering from the other store is the exact confusion being
      fixed.
    Inputs: transcript_id (int) - the id that was not found.
    Output: a not_found envelope with the cross-store meta attached.
    Example: message_model_not_found(5000)["meta"]["searched_table"]
    """
    from src.core.archive_envelope import not_found_envelope

    return not_found_envelope(
        f"transcript:{transcript_id}",
        f"no row in message_transcripts with id {transcript_id}",
        result=None,
        meta={
            "searched_table": "message_transcripts",
            "store": "message_model",
            "note":
                "this route exports the PARSED message model. If this id "
                "came from transcript_archives it will not be found here; "
                "the byte-exact archive is addressed by archive_uuid.",
            "archive_rowid_exchange_href":
                f"/api/v1/archive/archives/by-rowid/{transcript_id}",
        },
    )
