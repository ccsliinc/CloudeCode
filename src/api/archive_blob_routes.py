"""``/api/v1/archive/archives/*`` - the HTTP surface for ``transcript_archives``.

WHY THIS EXISTS BESIDE ``archive_export_routes`` AND DOES NOT REPLACE IT.
``/archive/transcripts/{id}/export`` reads the PARSED message model and
re-serializes it line by line, which is what lets it stream in bounded
memory and what makes the explorer searchable. This module reads
``transcript_archives`` and hands back the ORIGINAL FILE, byte for byte,
by decompressing one blob. Two stores, two jobs. The parsed model cannot
promise original bytes; the archive cannot answer a query about a message
block. Repointing either at the other's table would delete a real
capability, so neither is repointed.

That ``message_transcripts`` currently holds 0 rows is NOT the argument
for any of this - a corpus drain is populating it as this ships. The
durable argument is that the two stores are authoritative for different
things.

ONE EXPORT FORM, AND IT IS THE VERIFIED ONE. The sibling module offers a
streaming form and a verify-before-send form, because its line-by-line
reassembly genuinely can run in bounded memory. This one cannot:
``export_archive`` returns ``bytes``, so a reconstruction is fully
resident, and verifying a hash requires every byte anyway. Offering a
"streaming" form here would advertise a memory bound this path does not
have - a guarantee that cannot fail, which this API is written against.
So there is one form, it is always verified, and delivery is CHUNKED out
of the already-verified buffer purely so the ASGI layer does not hold a
second copy of a 244 MB payload. Chunked delivery, not bounded memory,
and the difference is said out loud in ``X-Archive-Memory-Model``.

THE ID SPACE. The public id is ``archive_uuid``, never the integer rowid.
See :mod:`src.core.archive_blob_export` for the measurement: both tables
are ``INTEGER PRIMARY KEY`` and both live in ``cloude-archive.db``, so an
integer would silently address the wrong store and return a real,
wrong transcript. An integer arriving here is REFUSED with a ``409``
naming both spaces and offering the explicit exchange route, never
resolved on a guess.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, Iterator, Optional, Tuple

import structlog
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, StreamingResponse

from src.api.archive_support import state_dir
from src.api.auth import require_auth
from src.core import archive_blob_export as blob
from src.core.archive_read import (
    API_PREFIX,
    RESULT_CANNOT_DETERMINE,
    RESULT_OK,
    SCOPE_RESOLVED,
    cannot_determine_envelope,
    envelope,
    not_found_envelope,
    open_read_only,
)
from src.core.db import DatastoreUnreadableError

logger = structlog.get_logger()

router = APIRouter(tags=["archive"])

#: How many archive exports may be in flight in this process at once.
#: Sized against a MEASURED reconstruction: the corpus's largest row is
#: 244,117,661 bytes and reconstructs in 416.5 ms fully resident, so one
#: worst-case export is roughly 250-500 MB depending on the decompressor's
#: own buffer. Two is about a gigabyte on a machine also running the app.
MAX_CONCURRENT_ARCHIVE_EXPORTS: int = 2

#: How long a request waits for a slot before refusing. A bounded refusal
#: that names the limit beats an unbounded wait that looks like a hang.
ARCHIVE_EXPORT_SLOT_WAIT_SECONDS: float = 30.0

#: Bytes per chunk when handing the verified buffer to the ASGI layer.
#: 1 MiB: large enough that a 244 MB payload is ~233 writes rather than
#: thousands, small enough that no chunk is itself a large allocation.
ARCHIVE_STREAM_CHUNK_BYTES: int = 1048576

_slots_singleton: Optional[asyncio.Semaphore] = None


def _slots() -> asyncio.Semaphore:
    """Return this process's export concurrency semaphore, built on first use.

    Description: built lazily rather than at import so it binds to the
      running loop, not to whichever loop happened to exist at import
      time - a semaphore bound to a dead loop refuses every request
      forever while looking correctly configured.
    Inputs: none.
    Output: asyncio.Semaphore with ``MAX_CONCURRENT_ARCHIVE_EXPORTS``.
    Example: await _slots().acquire()
    """
    global _slots_singleton
    if _slots_singleton is None:
        _slots_singleton = asyncio.Semaphore(MAX_CONCURRENT_ARCHIVE_EXPORTS)
    return _slots_singleton


def _wrong_id_space_envelope(value: str, exchange: Optional[str]) -> Dict[str, Any]:
    """Build the refusal for an integer arriving on a uuid-addressed route.

    Description: the id-space guard's whole payoff. A silent empty result
      or a bare 422 would leave the caller unable to tell WHICH mistake
      they made, and once the corpus drain populates
      ``message_transcripts`` an implicitly-resolved integer would return
      a real transcript that is the wrong one. So the refusal names both
      spaces, and when the integer IS a live archive rowid it hands back
      the canonical uuid so the caller can retry correctly.
    Inputs: value (str) - the integer as written. exchange (str | None) -
      the archive_uuid that rowid resolves to, or None when no archive row
      carries it.
    Output: a cannot_determine envelope carrying both hrefs.
    Example: _wrong_id_space_envelope("21961", "0001...")["meta"]
    """
    meta: Dict[str, Any] = {
        "id_space": {
            "this_route_addresses": "transcript_archives.archive_uuid",
            "value_looks_like": "an integer primary key",
            "ambiguous_between": [
                "transcript_archives.id",
                "message_transcripts.id",
            ],
            "why_refused":
                "both tables are INTEGER PRIMARY KEY and both live in "
                "cloude-archive.db, so resolving this integer implicitly "
                "could return a real transcript from the wrong store",
        },
        "message_model_href": f"{API_PREFIX}/transcripts/{value}/export",
        "rowid_exchange_href": f"{API_PREFIX}/archives/by-rowid/{value}",
    }
    if exchange is not None:
        meta["archive_uuid"] = exchange
        meta["retry_href"] = f"{API_PREFIX}/archives/{exchange}/export"
    return cannot_determine_envelope(
        f"archive:{value}",
        "this route is addressed by archive_uuid, not by an integer id; "
        + ("the archive row with that rowid is named in meta.archive_uuid"
           if exchange is not None
           else "no transcript_archives row carries that rowid, so it may "
                "be a message_transcripts id - see meta.message_model_href"),
        result=None, scope_status=SCOPE_RESOLVED, meta=meta,
    )


def _open_and_run(operation: str, value: str) -> Dict[str, Any]:
    """Open the archive read-only and run one blob operation, always closing.

    Description: kept out of every handler so each stays parse, delegate,
      return, and so "the database would not open" becomes a named status
      rather than an unexplained 500. Runs entirely in a worker thread.
    Inputs: operation (str) - 'head', 'export' or 'rowid'. value (str) -
      a canonical archive_uuid, or a digit string for 'rowid'.
    Output: dict with ``status`` and the operation's own keys, or
      ``status='unreadable'`` with a ``detail``.
    Example: _open_and_run("head", u)["status"] -> 'ok'
    """
    try:
        conn = open_read_only(state_dir())
    except DatastoreUnreadableError as exc:
        return {"status": "unreadable", "detail": str(exc)}
    try:
        if operation == "export":
            return blob.verified_archive_export(conn, value)
        if operation == "head":
            head = blob.archive_head(conn, value)
            return {
                "status": (blob.ARCHIVE_EXPORT_OK if head is not None
                           else blob.ARCHIVE_EXPORT_NOT_FOUND),
                "head": head,
                "detail": ("" if head is not None else
                           f"no row in transcript_archives with archive_uuid "
                           f"{value}"),
            }
        return {
            "status": blob.ARCHIVE_EXPORT_OK,
            "archive_uuid": blob.archive_uuid_for_rowid(conn, int(value)),
        }
    finally:
        conn.close()


async def _resolve_ref(value: str) -> Tuple[Optional[str], Optional[JSONResponse]]:
    """Turn a path value into a canonical archive_uuid or the refusal for it.

    Description: the ONE place a path value is classified, so no handler
      can invent a second rule. An integer is exchanged for its uuid ONLY
      to name it in the refusal - it is never served, because serving it
      would be resolving an ambiguous id on a guess.
    Inputs: value (str) - the raw path segment.
    Output: (canonical_uuid, None) when servable, else (None, response).
    Example: await _resolve_ref("21961") -> (None, <409>)
    """
    kind, canonical = blob.classify_archive_ref(value)
    if kind == blob.REF_ARCHIVE_UUID and canonical is not None:
        return canonical, None
    if kind == blob.REF_INTEGER_ID:
        looked_up = await asyncio.to_thread(_open_and_run, "rowid", value)
        exchange = (looked_up.get("archive_uuid")
                    if looked_up.get("status") != "unreadable" else None)
        logger.info("archive_blob_wrong_id_space", value=value,
                    resolved=exchange is not None)
        return None, JSONResponse(
            status_code=409, content=_wrong_id_space_envelope(value, exchange),
        )
    return None, JSONResponse(status_code=400, content=cannot_determine_envelope(
        f"archive:{value}",
        "not a canonical archive_uuid (36 characters, hyphenated) and not "
        "an integer id; nothing can be looked up from it",
        result=None, scope_status=SCOPE_RESOLVED,
        meta={"id_space": {
            "this_route_addresses": "transcript_archives.archive_uuid"}},
    ))


def _unreadable_response() -> JSONResponse:
    """Build the cannot_determine response for a datastore that would not open.

    Description: a 200 carrying an honest refusal, matching the sibling
      export routes. "Could not look" is never rendered as "not found",
      because a client would show the second as "this conversation is
      gone".
    Inputs: none. Output: JSONResponse.
    Example: _unreadable_response().status_code -> 200
    """
    return JSONResponse(status_code=200, content=envelope(
        result=None, result_status=RESULT_CANNOT_DETERMINE,
        scope_status="cannot_determine",
        unevaluated=[{"subject": "datastore",
                      "reason": "cloude-archive.db could not be opened"}],
    ))


def _chunks(payload: bytes) -> Iterator[bytes]:
    """Yield an already-verified buffer in fixed-size pieces.

    Description: delivery only. This does NOT bound memory - the whole
      payload is already resident and verified by the time this runs -
      it exists so the ASGI layer does not hold a SECOND full copy of a
      244 MB response. A memoryview is sliced so no chunk copies.
    Inputs: payload (bytes) - the verified reconstruction.
    Output: Iterator[bytes].
    Example: list(_chunks(b"abc")) -> [b'abc']
    """
    view = memoryview(payload)
    for start in range(0, len(view), ARCHIVE_STREAM_CHUNK_BYTES):
        yield bytes(view[start:start + ARCHIVE_STREAM_CHUNK_BYTES])


@router.get("/archive/archives/by-rowid/{rowid}", response_model=None,
            dependencies=[Depends(require_auth)])
async def get_archive_by_rowid(rowid: int) -> JSONResponse:
    """Exchange a ``transcript_archives`` integer rowid for its archive_uuid.

    Description: the EXPLICIT bridge out of the ambiguous integer space,
        for a caller that genuinely holds an archive rowid - the dedupe
        modules and ``verify_against_source`` do. It is a separate route
        rather than a fallback on the export path because a fallback
        would be guessing which store an integer came from, which is the
        defect this surface exists to prevent.

    Args:
        rowid: a ``transcript_archives.id``.

    Returns:
        ``200`` with the canonical ``archive_uuid`` and the export href,
        a ``404`` envelope when no archive row carries that rowid (which
        does NOT mean the integer is meaningless - it may be a valid
        ``message_transcripts`` id, and the envelope says so), or a
        ``200`` ``cannot_determine`` when the datastore would not open.
    """
    found = await asyncio.to_thread(_open_and_run, "rowid", str(rowid))
    if found.get("status") == "unreadable":
        return _unreadable_response()
    archive_uuid = found.get("archive_uuid")
    if archive_uuid is None:
        return JSONResponse(status_code=404, content=not_found_envelope(
            f"archive_rowid:{rowid}",
            f"no transcript_archives row with id {rowid}; this integer may "
            f"still be a valid message_transcripts id",
            result=None,
            meta={"message_model_href":
                  f"{API_PREFIX}/transcripts/{rowid}/export"},
        ))
    return JSONResponse(status_code=200, content=envelope(
        result={
            "archive_uuid": archive_uuid,
            "archive_id": rowid,
            "export_href": f"{API_PREFIX}/archives/{archive_uuid}/export",
        },
        result_status=RESULT_OK,
    ))


@router.get("/archive/archives/{archive_ref}", response_model=None,
            dependencies=[Depends(require_auth)])
async def get_archive_head(archive_ref: str) -> JSONResponse:
    """Report one archive row's metadata without reconstructing its content.

    Description: lets a caller learn ``raw_byte_length`` and decide
        whether it wants a 244 MB export before asking for one. Costs one
        indexed lookup regardless of the row's size, because
        ``content_gzip`` is never selected. ``is_superseded`` is reported
        so a client does not read a sentinel blob's
        ``compressed_byte_length`` as the row's real size - 3,924 rows
        carry an 8-byte sentinel whose bytes live forward along the chain.

    Args:
        archive_ref: the row's ``archive_uuid``.

    Returns:
        ``200`` with the metadata, ``404`` when there is no such row,
        ``409`` when an integer id was passed, ``400`` when the value is
        neither, or ``200`` ``cannot_determine`` when the datastore would
        not open.
    """
    canonical, refusal = await _resolve_ref(archive_ref)
    if refusal is not None:
        return refusal
    found = await asyncio.to_thread(_open_and_run, "head", canonical)
    if found.get("status") == "unreadable":
        return _unreadable_response()
    if found["head"] is None:
        return JSONResponse(status_code=404, content=not_found_envelope(
            f"archive:{canonical}", found["detail"], result=None,
        ))
    return JSONResponse(status_code=200, content=envelope(
        result=found["head"], result_status=RESULT_OK,
        meta={"export_href": f"{API_PREFIX}/archives/{canonical}/export"},
    ))


@router.get("/archive/archives/{archive_ref}/export", response_model=None,
            dependencies=[Depends(require_auth)])
async def get_archive_export(archive_ref: str) -> Any:
    """Reconstruct an archived transcript, verify it, and only THEN send it.

    Description: the byte-exact export. Reconstructs through
        ``export_archive``, which walks ``superseded_by_archive_id`` -
        3,924 of 23,475 rows hold an 8-byte sentinel instead of their own
        content and chains reach depth 267, so reading ``content_gzip``
        directly would return zero bytes for one row in six. Then BOTH the
        recorded sha256 and the recorded byte length are compared before
        anything is sent; a refusal reports both actual values so the
        comparison can be re-run.

        A source file missing from ``~/.claude/projects`` is NOT a refusal
        condition and is never consulted: 2,524 rows are in that state and
        every one is sound.

    Args:
        archive_ref: the row's ``archive_uuid``.

    Returns:
        ``200`` ``application/x-ndjson`` with the exact original bytes and
        ``X-Archive-Content-Sha256`` / ``-Bytes``; ``404`` no such row;
        ``409`` an integer id; ``413`` above the size ceiling; ``422`` a
        REFUSAL (``chain_broken``, ``reconstruction_failed`` or
        ``integrity_mismatch``) naming which check failed; ``503`` when no
        concurrency slot came free; ``200`` ``cannot_determine`` when the
        datastore would not open.
    """
    canonical, refusal = await _resolve_ref(archive_ref)
    if refusal is not None:
        return refusal
    try:
        await asyncio.wait_for(
            _slots().acquire(), timeout=ARCHIVE_EXPORT_SLOT_WAIT_SECONDS,
        )
    except asyncio.TimeoutError:
        return JSONResponse(status_code=503, content=cannot_determine_envelope(
            f"archive:{canonical}",
            f"{MAX_CONCURRENT_ARCHIVE_EXPORTS} archive exports are already "
            f"in flight and no slot came free within "
            f"{ARCHIVE_EXPORT_SLOT_WAIT_SECONDS}s. The bound exists because a "
            f"reconstruction is fully resident and the largest row in this "
            f"corpus is 244 MB. Retry.",
            result=None, scope_status=SCOPE_RESOLVED,
            meta={"limit": {
                "max_concurrent_exports": MAX_CONCURRENT_ARCHIVE_EXPORTS}},
        ))
    try:
        result = await asyncio.to_thread(_open_and_run, "export", canonical)
    except BaseException:
        _slots().release()
        raise
    status = result.get("status")
    if status != blob.ARCHIVE_EXPORT_OK:
        _slots().release()
        return _refusal_response(canonical, result)
    head = result["head"]
    logger.info("archive_blob_export_verified", archive_uuid=canonical,
                bytes_sent=result["actual_bytes"],
                is_superseded=head["is_superseded"])
    return StreamingResponse(
        _finishing(_chunks(result["payload"]), _slots().release),
        status_code=200, media_type="application/x-ndjson",
        headers={
            "Content-Length": str(result["actual_bytes"]),
            "Content-Disposition":
                f'attachment; filename="{canonical}.jsonl"',
            "X-Archive-Uuid": canonical,
            "X-Archive-Content-Sha256": str(result["actual_sha256"]),
            "X-Archive-Content-Bytes": str(result["actual_bytes"]),
            "X-Archive-Verified": "before_send",
            "X-Archive-Chain-Walked": "true" if head["is_superseded"] else "false",
            "X-Archive-Memory-Model": "fully_resident_then_chunked",
        },
    )


def _finishing(source: Iterator[bytes], release: Any) -> Iterator[bytes]:
    """Wrap a chunk iterator so a slot is released however the stream ends.

    Description: the semaphore must come back on a client disconnect and
      on an exception, not only on a clean finish - a leaked slot makes
      the endpoint refuse every later export with a concurrency message
      that is no longer true.
    Inputs: source (Iterator[bytes]), release (callable) - the release.
    Output: Iterator[bytes] yielding exactly what source yielded.
    Example: list(_finishing(iter([b"a"]), lambda: None)) -> [b'a']
    """
    try:
        for chunk in source:
            yield chunk
    finally:
        release()


def _refusal_response(canonical: str, result: Dict[str, Any]) -> JSONResponse:
    """Map a non-ok export status onto its HTTP refusal.

    Description: keeps REFUSAL (we looked, the reconstruction is wrong -
      safe to act on) apart from CANNOT_DETERMINE (we could not look -
      never report as "the transcript is bad"), which is the distinction
      docs/transcript-archive-integrity.md is built on. ``chain_broken``
      is 422 rather than 404 because the row DOES exist and a dangling
      chain pointer is a defect that must not hide behind a routine 404.
    Inputs: canonical (str) - the archive_uuid. result (dict) - the export
      record.
    Output: JSONResponse at 200, 404, 413 or 422.
    Example: _refusal_response(u, {"status": "not_found", ...}).status_code
    """
    status = result.get("status")
    head = result.get("head")
    if status == "unreadable":
        return _unreadable_response()
    if status == blob.ARCHIVE_EXPORT_NOT_FOUND:
        return JSONResponse(status_code=404, content=not_found_envelope(
            f"archive:{canonical}", result["detail"], result=None,
        ))
    if status == blob.ARCHIVE_EXPORT_TOO_LARGE:
        return JSONResponse(status_code=413, content=cannot_determine_envelope(
            f"archive:{canonical}", result["detail"], result=None,
            scope_status=SCOPE_RESOLVED,
            meta={"raw_byte_length": head["raw_byte_length"] if head else None,
                  "ceiling_bytes": blob.ARCHIVE_EXPORT_MAX_BYTES},
        ))
    logger.warning("archive_blob_export_refused", archive_uuid=canonical,
                   status=status)
    meta: Dict[str, Any] = {"refusal": status}
    if head is not None:
        meta["expected_sha256"] = head["content_sha256"]
        meta["expected_bytes"] = head["raw_byte_length"]
    if result.get("actual_sha256") is not None:
        meta["actual_sha256"] = result["actual_sha256"]
        meta["actual_bytes"] = result["actual_bytes"]
    return JSONResponse(status_code=422, content=cannot_determine_envelope(
        f"archive:{canonical}", result["detail"], result=None,
        scope_status=SCOPE_RESOLVED, meta=meta,
    ))
