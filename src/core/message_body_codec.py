"""Per-row compression for ``message_bodies.body_json``, and the two SQL
functions that make every reader correct on BOTH shapes.

WHY THE COLUMN CAN HOLD TWO THINGS, AND WHY THAT IS NOT A MESS. SQLite
columns are dynamically typed: a column DECLARED ``TEXT`` stores whatever
storage class it is handed. So a body is either

  ``typeof(body_json) = 'text'``  the JSON, verbatim, exactly as before
  ``typeof(body_json) = 'blob'``  this module's frame, holding zlib

and the ROW ITSELF declares which it is. That is what makes this a
migration with NO FLAG DAY: both shapes are legal forever, a reader
handles both, and the work remaining for the backfill is literally
``WHERE typeof(body_json) = 'text'`` - the work queue IS the data, so an
interrupted run resumes exactly where it stopped with no ledger table and
no antijoin. A separate BLOB column would have needed an ALTER that
cannot drop ``body_json``'s NOT NULL, so the old bytes would have stayed
and bought nothing.

MEASURED ON 216,716 REAL BODIES (the 400-transcript projection,
2026-09-13). zlib level 6 takes 756.8 MiB of ``body_json`` to 398.1 MiB,
a ratio of 0.526. Level 9 reaches 397.8 MiB for 10 percent more CPU and
is not worth it; level 1 stops at 411.5 MiB. Encode costs 56.7 us per
body, decode 6.30 us mean (p50 3.50, p95 11.88, p99 46.83).

THE 12-BYTE FRAME EXISTS BECAUSE OF THE TAIL, NOT BECAUSE OF THE MAGIC.
A zlib stream does not record how long its output will be, so answering
``LENGTH(body_json)`` from a compressed row would mean inflating it. The
largest body in that corpus is 12,592,257 characters and inflating it
costs 18.55 ms - and ``archive_body`` asks for that length precisely in
order to REFUSE to return a body that big. Paying 18.55 ms to discover
that you are not going to return the value is the whole cost of the
feature landing on the one row that can least afford it. So the frame
carries the character count and :func:`body_chars` reads 12 bytes.

THE COUNT IS CODE POINTS, NOT BYTES, because that is what SQLite's
``LENGTH()`` returns for a TEXT value and what every existing caller
already means by ``body_chars`` / ``body_bytes`` (see
``src/core/archive_body.py``, which says so at length, and the secret
offsets, which are code-point based). Storing the UTF-8 byte count here
would change the meaning of ``match_offset`` on every multi-byte body,
silently, in a way no test on ASCII fixtures could see.

THE MAGIC IS A SECOND, INDEPENDENT DECLARATION and it is deliberate
belt-and-braces: ``typeof()`` answers from SQL, the magic answers in
Python, and a blob that is neither is REFUSED loudly rather than being
guessed at as either. There is no rung that says "it looks like zlib, try
inflating it".
"""

from __future__ import annotations

import sqlite3
import struct
import zlib
from typing import Any, Optional, Union

#: Frame magic. Four bytes, so the frame header is 12 and every offset in
#: it is readable by eye in a hex dump. "CBZ" is cloude body zlib; the 1
#: is the frame version, and a second version would be a second constant
#: here rather than a reinterpretation of this one.
BODY_FRAME_MAGIC: bytes = b"CBZ1"

#: ``<Q`` - unsigned 64-bit little-endian character count. 64 bits rather
#: than 32 so there is no body size at which this module has to refuse,
#: and therefore no refusal path that only fires on a corpus nobody has.
_COUNT_STRUCT: struct.Struct = struct.Struct("<Q")

#: Bytes before the zlib stream begins: magic plus count.
BODY_FRAME_HEADER_BYTES: int = len(BODY_FRAME_MAGIC) + _COUNT_STRUCT.size

#: zlib level. 6 is measured as the knee; see the module docstring.
BODY_COMPRESSION_LEVEL: int = 6

#: The two SQL function names this module registers. Named constants
#: because every repointed query spells them and a typo in one query is
#: a loud "no such function" only if the name is spelled from here.
SQL_FN_BODY_TEXT: str = "cloude_body_text"
SQL_FN_BODY_CHARS: str = "cloude_body_chars"


class BodyCodecError(ValueError):
    """A stored body could not be interpreted as either shape.

    Description: raised rather than returning None or an empty string,
      because a body that cannot be read is a COULD NOT EVALUATE and a
      caller that receives "" will render it as an empty message. The
      message names what was found, never the body's content.
    Inputs: standard ValueError arguments.
    Output: an exception instance.
    """


def is_compressed(value: Any) -> bool:
    """Say whether a stored ``body_json`` value is in this module's frame.

    Description: the ONE place the frame is recognised. A ``str`` is
      never compressed; a ``bytes``/``memoryview`` is compressed only
      when it actually carries the magic, so a blob written by something
      else is not silently inflated.
    Inputs: value (Any) - whatever the column handed back.
    Output: bool.
    Example: is_compressed(encode_body('{"a":1}')) -> True
    """
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value[:len(BODY_FRAME_MAGIC)]) == BODY_FRAME_MAGIC
    return False


def encode_body(text: str) -> bytes:
    """Frame and compress one body for storage.

    Description: the only writer of the frame. The character count is
      taken from the STRING (code points), not from its UTF-8 encoding.
    Inputs: text (str) - exactly what would otherwise be stored.
    Output: bytes - magic, count, zlib stream.
    Raises: TypeError - text is not a str, which would otherwise store a
      blob whose count means nothing.
    Example: decode_body(encode_body('{"a":1}')) == '{"a":1}'
    """
    if not isinstance(text, str):
        raise TypeError(
            f"encode_body needs a str; got {type(text).__name__}"
        )
    payload = zlib.compress(text.encode("utf-8"), BODY_COMPRESSION_LEVEL)
    return BODY_FRAME_MAGIC + _COUNT_STRUCT.pack(len(text)) + payload


def decode_body(value: Union[str, bytes, bytearray, memoryview]) -> str:
    """Return the body's JSON text, whichever shape it was stored in.

    Description: the identity function on an uncompressed row, which is
      what lets every reader be repointed at it BEFORE a single row is
      compressed. An install that never compresses anything behaves
      exactly as it did.
    Inputs: value - the ``body_json`` column value.
    Output: str - the JSON text.
    Raises: BodyCodecError - a blob that is not a frame, a frame whose
      zlib stream will not inflate, or a frame whose recorded character
      count disagrees with what came out. That last check is not
      decoration: the count is what ``body_chars`` answers from without
      inflating, so a count that lies is a wrong ``LENGTH()`` nothing
      else would ever notice.
    Example: decode_body('{"a":1}') -> '{"a":1}'
    """
    if isinstance(value, str):
        return value
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise BodyCodecError(
            f"body_json held {type(value).__name__}, which is neither text "
            f"nor a stored body frame"
        )
    raw = bytes(value)
    if not is_compressed(raw):
        raise BodyCodecError(
            f"body_json held a {len(raw)} byte blob that does not carry the "
            f"{BODY_FRAME_MAGIC!r} frame magic; refusing to guess at it"
        )
    try:
        text = zlib.decompress(raw[BODY_FRAME_HEADER_BYTES:]).decode("utf-8")
    except (zlib.error, UnicodeDecodeError) as exc:
        raise BodyCodecError(
            f"a framed body would not inflate: {type(exc).__name__}: {exc}"
        ) from exc
    declared = _framed_char_count(raw)
    if declared != len(text):
        raise BodyCodecError(
            f"a framed body declares {declared} characters and inflated to "
            f"{len(text)}; the frame and its payload disagree"
        )
    return text


def body_chars(value: Union[str, bytes, bytearray, memoryview]) -> int:
    """Return the body's CHARACTER count without inflating it.

    Description: what ``LENGTH(body_json)`` used to answer, and what it
      still has to answer, for both shapes. On a compressed row this
      reads 12 bytes; on the corpus's largest body that is the
      difference between free and 18.55 ms.
    Inputs: value - the ``body_json`` column value.
    Output: int - code points.
    Raises: BodyCodecError - the value is neither shape.
    Example: body_chars(encode_body("abc")) -> 3
    """
    if isinstance(value, str):
        return len(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        if is_compressed(raw):
            return _framed_char_count(raw)
    raise BodyCodecError(
        f"body_json held {type(value).__name__} with no readable length; "
        f"refusing to report a count nothing measured"
    )


def _framed_char_count(raw: bytes) -> int:
    """Read the character count out of a frame header.

    Inputs: raw (bytes) - a value :func:`is_compressed` has accepted.
    Output: int.
    Raises: BodyCodecError - the frame is shorter than its own header.
    """
    if len(raw) < BODY_FRAME_HEADER_BYTES:
        raise BodyCodecError(
            f"a stored body frame is {len(raw)} bytes, shorter than its "
            f"{BODY_FRAME_HEADER_BYTES} byte header"
        )
    start = len(BODY_FRAME_MAGIC)
    return int(_COUNT_STRUCT.unpack_from(raw, start)[0])


def _sql_body_text(value: Any) -> Optional[str]:
    """SQL shim for :func:`decode_body`, NULL-tolerant.

    Description: SQLite hands NULL through as None and expects None back;
      every other failure is raised so the query fails loudly rather than
      producing a row whose body reads as empty.
    Inputs: value (Any) - the column value.
    Output: str or None.
    """
    if value is None:
        return None
    return decode_body(value)


def _sql_body_chars(value: Any) -> Optional[int]:
    """SQL shim for :func:`body_chars`, NULL-tolerant.

    Inputs: value (Any). Output: int or None.
    """
    if value is None:
        return None
    return body_chars(value)


def register_body_functions(conn: sqlite3.Connection) -> None:
    """Register ``cloude_body_text`` and ``cloude_body_chars`` on a connection.

    Description: called from ``src.core.db.connect``, which is the one
      place this app opens ``cloude.db``, so every read path gets them.
      A connection that somehow missed them fails a repointed query with
      "no such function", which is LOUD. Measured on sqlite 3.53.4, what
      the UNREPOINTED spellings answer for a compressed row: ``LENGTH``
      its COMPRESSED byte count, ``SUBSTR`` a slice of the zlib stream,
      ``INSTR`` 0 - three silent wrong answers. ``json_valid`` answers 0
      and ``json_extract`` raises "malformed JSON", so those two are the
      only ones that would have been noticed.

      Both are declared deterministic so the planner may use them in an
      index expression and may cache their result within a statement.
    Inputs: conn (sqlite3.Connection).
    Output: None.
    Raises: sqlite3.Error - registration itself failed, which the caller
      turns into a datastore-unreadable refusal rather than handing back
      a connection whose queries would be wrong.
    Example: register_body_functions(conn); conn.execute(
        "SELECT cloude_body_chars(body_json) FROM message_bodies")
    """
    conn.create_function(
        SQL_FN_BODY_TEXT, 1, _sql_body_text, deterministic=True,
    )
    conn.create_function(
        SQL_FN_BODY_CHARS, 1, _sql_body_chars, deterministic=True,
    )
