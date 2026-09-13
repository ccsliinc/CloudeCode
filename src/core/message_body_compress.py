"""The compression POLICY, and the bounded backfill that applies it.

THE CODEC AND THE POLICY ARE TWO THINGS. ``message_body_codec`` knows how
to frame and unframe a body and nothing else; this module decides WHETHER
a given body is worth framing, and moves the ones already on disk. Keeping
them apart is what lets every reader be repointed at the codec without
inheriting a decision about when to compress.

THE COUPLING, STATED ONCE. This is only safe because search no longer
greps ``body_json``: the column was stored as plain TEXT precisely so
``INSTR`` could scan it. With the matcher moved onto
``message_content_blocks`` and the FTS5 index, nothing reads the column
as text except through ``cloude_body_text``, which is correct on both
shapes. Landing this without the search change would blind search to
every compressed row, silently.

MEASURED ON 216,716 REAL BODIES, 2026-09-13: 756.8 MiB to 398.1 MiB at
level 6, a ratio of 0.526. Encode 56.7 us per body, decode 6.30 us mean.

SMALL BODIES ARE LEFT ALONE, and the threshold is measured rather than
picked. zlib on a very short string produces MORE bytes than it consumed
once the 12-byte frame is added, so below ``MIN_COMPRESS_CHARS`` the row
stays TEXT - which costs nothing, because a TEXT row is exactly what
every reader already handles. The rule is applied as a MEASUREMENT, not
as a guess: :func:`encode_if_smaller` compresses, compares, and keeps
whichever is shorter, so a large but incompressible body (base64, a
random blob) also stays TEXT rather than growing.

RESUMABLE WITH NO LEDGER. The work remaining is
``WHERE typeof(body_json) = 'text'``, which is the data itself, so an
interrupted pass resumes exactly and a second pass over a finished
database finds nothing. There is no state to reconcile and no way for a
ledger to disagree with the rows.

BOUNDED BY ROWS, NOT BY A CLOCK. A time bound makes the work a pass does
depend on how loaded the box was, so two runs are not comparable and a
test cannot pin one.
"""

from __future__ import annotations

import os
import sqlite3
import time
from dataclasses import dataclass
from typing import List, Optional, Tuple

import structlog

from src.core.message_body_codec import (
    BODY_FRAME_HEADER_BYTES,
    decode_body,
    encode_body,
)

logger = structlog.get_logger()

#: Below this many characters a body is left as TEXT. 200 is comfortably
#: above the point where the 12-byte frame plus zlib's own header stops
#: being repaid, and the comparison in :func:`encode_if_smaller` is what
#: actually decides - this is only there to skip the attempt.
MIN_COMPRESS_CHARS: int = 200

#: Rows one backfill pass will rewrite. 5,000 bodies is about 0.3 s of
#: deflate at the measured rate, which is a bounded write transaction
#: rather than one holding the write lock for minutes on a live install.
DEFAULT_BATCH_ROWS: int = 5_000

#: Environment switch for the WRITE path. Default on. Set to "0" to store
#: new bodies as TEXT, which every reader still handles, so turning it off
#: is safe at any moment and needs no migration back.
ENV_COMPRESSION: str = "CLOUDE_BODY_COMPRESSION"

#: The work queue, and the whole reason no ledger table exists.
PENDING_SQL: str = (
    "SELECT id, body_json FROM message_bodies "
    "WHERE typeof(body_json) = 'text' AND LENGTH(body_json) >= :floor "
    "ORDER BY id LIMIT :cap"
)

PENDING_COUNT_SQL: str = (
    "SELECT COUNT(*) FROM message_bodies "
    "WHERE typeof(body_json) = 'text' AND LENGTH(body_json) >= :floor"
)

#: Shape census, for an operator and for the status report. ``typeof``
#: IS the declaration, so this is the authoritative answer to "how far
#: along is this install", with no derived state to go stale.
SHAPE_CENSUS_SQL: str = (
    "SELECT typeof(body_json) AS shape, COUNT(*) AS n, "
    "       SUM(LENGTH(body_json)) AS stored_units "
    "FROM message_bodies GROUP BY shape"
)


def compression_enabled(env: Optional[dict] = None) -> bool:
    """Say whether NEW bodies should be stored compressed.

    Description: reads the environment on every call rather than at
      import, so a test that sets it is actually followed. Anything other
      than the literal "0" is on, because a typo must not silently
      disable a storage decision.
    Inputs: env (dict|None) - defaults to os.environ.
    Output: bool.
    Example: compression_enabled({"CLOUDE_BODY_COMPRESSION": "0"}) -> False
    """
    source = os.environ if env is None else env
    return str(source.get(ENV_COMPRESSION, "1")) != "0"


def encode_if_smaller(text: str) -> object:
    """Return the frame when it is smaller than the text, else the text.

    Description: a MEASUREMENT rather than a heuristic. A base64 payload
      or an already-compressed blob does not shrink, and storing a frame
      that is larger than what it replaced would make the feature cost
      space on exactly the rows that are biggest. Comparing UTF-8 byte
      lengths is the right comparison because that is what SQLite stores
      for both shapes.
    Inputs: text (str) - the body JSON as it would otherwise be stored.
    Output: bytes (the frame) or str (the original), whichever is smaller.
    Example: encode_if_smaller("{}")  -> '{}'
    """
    if len(text) < MIN_COMPRESS_CHARS:
        return text
    framed = encode_body(text)
    return framed if len(framed) < len(text.encode("utf-8")) else text


def stored_value_for(text: str, env: Optional[dict] = None) -> object:
    """Decide what actually goes into ``body_json`` for a new body.

    Description: the ONE place the write path asks the question, so the
      ingest path and the projection path cannot answer it differently.
    Inputs: text (str), env (dict|None).
    Output: bytes or str.
    Example: stored_value_for("{}") -> '{}'
    """
    if not compression_enabled(env):
        return text
    return encode_if_smaller(text)


@dataclass(frozen=True)
class CompressReport:
    """What one backfill pass did.

    Description: ``pending_after`` is what makes a partial pass legible -
      a caller loops until it is 0 rather than guessing from ``rewritten``.
      ``skipped_not_smaller`` counts the rows measured and left alone,
      which is a different thing from rows not yet looked at.
    Inputs: constructed by :func:`compress_pending`.
    Output: a frozen record.
    """

    rewritten: int
    skipped_not_smaller: int
    pending_before: int
    pending_after: int
    chars_before: int
    bytes_after: int
    elapsed_seconds: float

    @property
    def ratio(self) -> Optional[float]:
        """Stored bytes after over UTF-8 bytes before, or None.

        Output: float or None when nothing was rewritten - 0.0 would be a
          measurement of perfect compression.
        """
        if not self.chars_before:
            return None
        return self.bytes_after / self.chars_before


def pending_compression_count(conn: sqlite3.Connection) -> int:
    """Count the bodies a backfill would still rewrite.

    Inputs: conn (sqlite3.Connection).
    Output: int.
    Example: pending_compression_count(conn) -> 216716
    """
    return int(conn.execute(
        PENDING_COUNT_SQL, {"floor": MIN_COMPRESS_CHARS},
    ).fetchone()[0])


def compress_pending(
    conn: sqlite3.Connection, *, max_rows: int = DEFAULT_BATCH_ROWS,
) -> CompressReport:
    """Rewrite up to ``max_rows`` uncompressed bodies in place.

    Description: the caller owns the transaction; this issues no BEGIN
      and no COMMIT. Every rewrite is verified BEFORE it is written -
      the frame is decoded again and compared to the original string, so
      a body can only be replaced by something that provably reproduces
      it. That check costs 6.30 us against the 56.7 us the encode already
      cost and it is the difference between a storage change and a data
      loss.
    Inputs: conn (sqlite3.Connection) - writable. max_rows (int).
    Output: CompressReport.
    Raises: sqlite3.Error - propagated so the caller's transaction rolls
      back. ValueError - a round trip did not reproduce the original,
      which stops the pass rather than skipping the row quietly.
    Example: compress_pending(conn, max_rows=100).pending_after
    """
    started = time.perf_counter()
    before = pending_compression_count(conn)
    rows = conn.execute(
        PENDING_SQL, {"floor": MIN_COMPRESS_CHARS, "cap": int(max_rows)},
    ).fetchall()
    updates: List[Tuple[bytes, int]] = []
    skipped = 0
    chars_before = 0
    bytes_after = 0
    for row in rows:
        body_id, text = int(row[0]), row[1]
        framed = encode_if_smaller(text)
        if not isinstance(framed, bytes):
            skipped += 1
            continue
        # Verified, not assumed. A rewrite that cannot be read back is
        # the one failure this pass must never commit.
        if decode_body(framed) != text:
            raise ValueError(
                f"body {body_id} did not survive a compress/decompress "
                f"round trip; refusing to rewrite it"
            )
        updates.append((framed, body_id))
        chars_before += len(text.encode("utf-8"))
        bytes_after += len(framed)
    if updates:
        conn.executemany(
            "UPDATE message_bodies SET body_json = ? WHERE id = ?", updates,
        )
    after = pending_compression_count(conn)
    report = CompressReport(
        len(updates), skipped, before, after, chars_before, bytes_after,
        time.perf_counter() - started,
    )
    logger.info(
        "body_compression_pass", rewritten=report.rewritten,
        skipped_not_smaller=report.skipped_not_smaller,
        pending_before=before, pending_after=after,
        ratio=report.ratio,
        elapsed_seconds=round(report.elapsed_seconds, 3),
    )
    return report


def shape_census(conn: sqlite3.Connection) -> dict:
    """Report how many bodies are in each storage shape.

    Description: ``typeof(body_json)`` is the row's own declaration, so
      this needs no derived state and cannot go stale. The frame header
      is subtracted from nothing - ``stored_units`` is characters for
      text and bytes for a blob, which is what SQLite counts, and the
      key names say which.
    Inputs: conn (sqlite3.Connection).
    Output: dict - {"text": {...}, "blob": {...}}, plus
      ``frame_header_bytes`` so a reader can account for the overhead.
    Example: shape_census(conn)["blob"]["rows"] -> 216716
    """
    out = {"frame_header_bytes": BODY_FRAME_HEADER_BYTES}
    for row in conn.execute(SHAPE_CENSUS_SQL):
        out[str(row[0])] = {
            "rows": int(row[1]),
            "stored_units": int(row[2] or 0),
        }
    return out
