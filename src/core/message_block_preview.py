"""The ONLY supported way to serve a content block's text to a caller.

WHY THIS MODULE EXISTS AT ALL. ``message_content_blocks.text`` holds
1.22 GiB of text projected out of ``message_bodies.body_json``. A block's
text is a SUBSTRING of the body text that ``archive_snippet_gate``
already governs, so it carries exactly the same credential exposure and
must inherit exactly the same gate. A block-derived preview that read
the column directly would be a second, ungoverned path to text the gate
exists to withhold - the table would have become "a second uncontrolled
copy of secret-bearing text that the existing withhold gate does not
know about".

HOW THE GATE RELATES TO BLOCK TEXT, PRECISELY. The gate's three layers
need two things, and a block row has both:

  layer 1, flagged body       keys on ``body_id``.
                              ``message_secret_findings.body_id`` and
                              ``message_content_blocks.body_id`` are the
                              SAME key into the SAME table, so a block
                              of a flagged body is withheld by the same
                              lookup that withholds the body's snippet.
                              No new join and no new policy.
  layer 2, window detectors   run over arbitrary text. A block's text is
                              a window like any other.
  layer 3, known-value hashes run over arbitrary text, by hash
                              membership. Same.

So there is no new gate here. This module does not re-implement one, and
deliberately holds no thresholds, no allowlist and no detector of its
own - it hands the block's ``body_id`` and its text to the existing gate
and returns what the gate says.

WHAT IT DOES NOT CLOSE. Layer 3 knows a credential this corpus has
detected SOMEWHERE. A credential never detected anywhere is invisible to
all three layers, exactly as it is for a body snippet, for the same
measured structural reason recorded in archive_snippet_gate's docstring.
Block granularity neither improves nor worsens that recall. A caller
needing a hard guarantee asks for no preview.

THE THIRD OUTCOME IS A WITHHOLD. If the gate cannot be built the preview
is withheld, never served. "I could not evaluate whether this is safe"
must not render as "this is safe".
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Optional

from src.core.archive_snippet_gate import (
    SNIPPET_INCLUDED,
    SNIPPET_WITHHELD_BY_REQUEST,
    evaluate_text_window,
    load_index,
)

#: Longest preview served for one block, in characters. A preview is a
#: glance, not a payload: the caller who wants the whole block asks for
#: the body through the export path, which is the authoritative one.
#: Bounding it also bounds the cost of the gate's layer-3 run-scan, which
#: is superlinear in window length.
BLOCK_PREVIEW_MAX_CHARS: int = 400


@dataclass(frozen=True)
class BlockPreview:
    """One block's preview and the gate verdict that produced it.

    Attributes:
        state: the gate's verdict string. SNIPPET_INCLUDED, or one of
            archive_snippet_gate's withhold states naming which layer
            tripped.
        text: the preview, or None whenever state is not
            SNIPPET_INCLUDED. Withholding never yields partial text.
        text_length: the FULL projected length of the block, reported
            whatever the verdict. Withholding a preview never suppresses
            the fact that the block exists or how big it is.
    """

    state: str
    text: Optional[str]
    text_length: int

    @property
    def included(self) -> bool:
        """Whether the preview text may be shown.

        Inputs: none.
        Output: bool.
        Example: BlockPreview("included", "a", 1).included -> True
        """
        return self.state == SNIPPET_INCLUDED


def gated_block_preview(
    conn: sqlite3.Connection,
    body_id: int,
    text: Optional[str],
    text_length: int,
    want_preview: bool = True,
    max_chars: int = BLOCK_PREVIEW_MAX_CHARS,
) -> BlockPreview:
    """Decide whether one block's text may be previewed, and return it.

    Description: the single gate-crossing for block text. Callers pass
      the row they already read; this function never widens the window
      beyond max_chars and never returns text the gate did not clear.
    Inputs: conn (sqlite3.Connection) - to build the known-secret index.
      body_id (int) - the block's owning body, the gate's layer-1 key.
      text (str | None) - the block's projected text, None when the type
      carries none. text_length (int) - the block's full length.
      want_preview (bool) - False asks for no preview at all.
      max_chars (int) - preview ceiling.
    Output: BlockPreview.
    Example: gated_block_preview(conn, 1, None, 0).state -> "included"
    """
    if not want_preview:
        return BlockPreview(
            state=SNIPPET_WITHHELD_BY_REQUEST, text=None,
            text_length=text_length,
        )
    if text is None:
        # A type that carries no text has nothing to withhold and
        # nothing to leak. It is included as an empty preview rather
        # than withheld, because there is no secret-bearing window here
        # to have failed to evaluate.
        return BlockPreview(
            state=SNIPPET_INCLUDED, text=None, text_length=text_length,
        )
    window = text[:max_chars]
    state = evaluate_text_window(conn, body_id, window, load_index(conn))
    if state != SNIPPET_INCLUDED:
        return BlockPreview(state=state, text=None, text_length=text_length)
    return BlockPreview(
        state=SNIPPET_INCLUDED, text=window, text_length=text_length,
    )
