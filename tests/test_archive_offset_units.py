"""Offsets are UNICODE CODE POINTS, and the JS masking recipe must use
the UTF-16 pair.

WHY EVERY BODY HERE IS NON-ASCII. A pure-ASCII fixture cannot tell a
character implementation from a byte implementation - the two agree on
every offset - so an ASCII test of this property asserts nothing and
passes forever while the contract rots. Two agents reached opposite
conclusions about this field on 2026-08-31 and the ASCII tests were
green for both. Every body below therefore carries multi-byte text
BEFORE the secret, and the astral cases carry emoji before it so the
code-point and UTF-16 answers differ too.
"""

from __future__ import annotations

import hashlib
import json
from contextlib import closing

from src.core.archive_body import body
from src.core.archive_read import (
    BODY_SIZE_UNITS,
    OFFSET_UNITS_CODE_POINTS,
    offset_units_meta,
    open_read_only,
)
from src.core.archive_search import search_scoped
from tests.archive_fixture import (
    make_state_dir,
    seed_appearance,
    seed_body,
    seed_corpus,
    seed_host,
    seed_project,
    seed_transcript,
    writable,
)

SECRET = "Q7xLm2Wp9RtVzB4kNc6JhY8dFgA3sEuT"


def _seed(tmp_path, prefix, name):
    """Seed one body of ``prefix + 'token=' + SECRET`` and its finding.

    Inputs: tmp_path, prefix (str - text placed BEFORE the secret),
      name (str - unique state dir name).
    Output: (state_dir, body_id, payload, offset, transcript_id).
    """
    payload = f'{prefix}token={SECRET}'
    offset = payload.index(SECRET)
    assert len(payload.encode("utf-8")) != len(payload), (
        "fixture must be multi-byte or it cannot discriminate"
    )
    state_dir = make_state_dir(tmp_path, name)
    with closing(writable(state_dir)) as conn:
        with conn:
            host_id = seed_host(conn)
            corpus_id = seed_corpus(conn, host_id)
            project_id = seed_project(conn, corpus_id, slug="-p")
            transcript_id = seed_transcript(
                conn, host_id=host_id, corpus_id=corpus_id,
                project_id=project_id, source_path="s.jsonl", line_count=1,
            )
            body_id = seed_body(
                conn, body_json=payload, secret_finding_count=1,
                identity_key=name,
            )
            seed_appearance(
                conn, transcript_id=transcript_id, line_no=1, body_id=body_id
            )
            conn.execute(
                "INSERT INTO message_secret_findings "
                "(body_id, detector, match_offset, match_length, "
                " value_sha256, observed_at) "
                "VALUES (?, 'high_entropy_assignment', ?, ?, ?, ?)",
                (body_id, offset, len(SECRET),
                 hashlib.sha256(SECRET.encode()).hexdigest(),
                 "2026-08-31T00:00:00Z"),
            )
    return state_dir, body_id, payload, offset, transcript_id


def test_offset_is_code_points_not_bytes(tmp_path):
    """The stored offset slices the body as CHARACTERS. The byte
    interpretation is asserted to FAIL, so this test can only pass for
    the right reason."""
    state_dir, body_id, payload, offset, _ = _seed(
        tmp_path, "é" * 12 + " ", "cp")
    with closing(open_read_only(state_dir)) as conn:
        finding = body(conn, body_id)["result"]["secrets"][0]

    off, ln = finding["match_offset"], finding["match_length"]
    want = finding["value_sha256"]

    char_slice = payload[off:off + ln]
    assert hashlib.sha256(char_slice.encode()).hexdigest() == want

    byte_slice = payload.encode("utf-8")[off:off + ln]
    assert hashlib.sha256(byte_slice).hexdigest() != want, (
        "byte interpretation must NOT reproduce the hash; if it does the "
        "fixture stopped discriminating"
    )


def test_utf16_pair_is_what_a_js_client_must_slice(tmp_path):
    """The client-side masking recipe, executed. An astral character
    sits before the secret, so the code-point offset and the UTF-16
    offset genuinely differ and only one of them masks correctly."""
    state_dir, body_id, payload, offset, _ = _seed(
        tmp_path, "🔑🔑🔑 é ", "utf16")
    with closing(open_read_only(state_dir)) as conn:
        finding = body(conn, body_id)["result"]["secrets"][0]

    assert finding["utf16_state"] == "computed"
    u_off = finding["match_offset_utf16"]
    u_len = finding["match_length_utf16"]
    assert u_off != finding["match_offset"], (
        "astral prefix must make the two units differ, else no discrimination"
    )

    # Exactly what JavaScript String.prototype.slice does.
    units = payload.encode("utf-16-le")
    masked = units[u_off * 2:(u_off + u_len) * 2].decode("utf-16-le")
    assert hashlib.sha256(masked.encode()).hexdigest() == finding["value_sha256"]

    # And the naive recipe the docs used to imply is WRONG here.
    wrong = units[offset * 2:(offset + u_len) * 2].decode("utf-16-le")
    assert wrong != masked


def test_body_chars_counts_characters_and_body_bytes_is_the_same_number(
    tmp_path,
):
    """``body_bytes`` is a code-point count. The truthful name carries
    the same value; both are asserted so a future divergence is loud."""
    state_dir, body_id, payload, _, _ = _seed(tmp_path, "é" * 20 + " ", "size")
    with closing(open_read_only(state_dir)) as conn:
        result = body(conn, body_id)["result"]

    assert result["body_chars"] == len(payload)
    assert result["body_chars"] != len(payload.encode("utf-8"))
    assert result["body_bytes"] == result["body_chars"]


def test_search_and_secret_offsets_share_a_unit_and_name_their_frames(
    tmp_path,
):
    """One UNIT, two FRAMES, and the API says which is which.

    Description: this test used to assert the two ``match_offset`` fields
      were EQUAL. That stopped being true, deliberately, when search moved
      off ``body_json`` and onto the extracted content blocks: a hit's
      offset now indexes the BLOCK's text and a finding's still indexes
      the BODY's JSON. Two different strings, so two different numbers.

      What must still hold - and is what the original test was really
      protecting - is that both are CODE POINTS, and that a reader can
      tell which string each one indexes without guessing. ``hit
      ["match_offset_in"]`` carries that, and both slices are executed
      here against their own string rather than compared as bare
      integers.

      The body is a REAL record shape. The old fixture stored a bare
      ``'ééé token=...'``, which is not JSON and therefore has no content
      blocks at all; it only ever worked because the matcher grepped raw
      body_json.
    """
    prefix = "é" * 9 + " "
    text = f"{prefix}token={SECRET}"
    payload = json.dumps(
        {"type": "assistant",
         "message": {"role": "assistant",
                     "content": [{"type": "text", "text": text}]}},
        ensure_ascii=False)
    body_offset = payload.index(SECRET)
    text_offset = text.index(SECRET)
    assert body_offset != text_offset, (
        "the two frames must differ here or this test discriminates nothing")
    assert len(payload.encode("utf-8")) != len(payload), (
        "fixture must be multi-byte or it cannot discriminate")

    state_dir = make_state_dir(tmp_path, "frames")
    with closing(writable(state_dir)) as conn:
        with conn:
            host_id = seed_host(conn)
            corpus_id = seed_corpus(conn, host_id)
            project_id = seed_project(conn, corpus_id, slug="-p")
            transcript_id = seed_transcript(
                conn, host_id=host_id, corpus_id=corpus_id,
                project_id=project_id, source_path="s.jsonl", line_count=1,
            )
            body_id = seed_body(
                conn, body_json=payload, secret_finding_count=1,
                identity_key="frames",
            )
            seed_appearance(
                conn, transcript_id=transcript_id, line_no=1, body_id=body_id
            )
            conn.execute(
                "INSERT INTO message_secret_findings "
                "(body_id, detector, match_offset, match_length, "
                " value_sha256, observed_at) "
                "VALUES (?, 'high_entropy_assignment', ?, ?, ?, ?)",
                (body_id, body_offset, len(SECRET),
                 hashlib.sha256(SECRET.encode()).hexdigest(),
                 "2026-08-31T00:00:00Z"),
            )

    with closing(open_read_only(state_dir)) as conn:
        hits = search_scoped(conn, SECRET, "transcript", transcript_id)
        finding = body(conn, body_id)["result"]["secrets"][0]
    assert hits["result"], hits["unevaluated"]
    hit = hits["result"][0]

    # The hit's frame, named and then executed against its own string.
    assert hit["match_offset_in"] == "block_text"
    assert hit["match_offset"] == text_offset
    assert (text[hit["match_offset"]:
                 hit["match_offset"] + hit["match_length"]] == SECRET)

    # The finding's frame is the body, unchanged.
    assert finding["match_offset"] == body_offset
    assert (payload[finding["match_offset"]:
                    finding["match_offset"] + finding["match_length"]]
            == SECRET)

    # ONE UNIT: both are code points, which is the claim that survived.
    assert hit["body_chars"] == len(payload) != len(payload.encode("utf-8"))
