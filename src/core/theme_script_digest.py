"""Measure the bytes of a theme's ``effects.js``, so a grant can name them.

WHY A DIGEST EXISTS AT ALL. Script consent became a SHARED setting in #45,
which means an ``always`` clicked on a phone authorises execution on a
desktop the user is not sitting at. ``docs/ui-preferences-inventory.md``
recommended against exactly that, and it was right about the thing it was
describing: a grant keyed on a theme ID ALONE is a standing authorisation
for whatever that file later becomes. A theme directory is a folder on
disk that the user, or anything with write access to it, can edit after
the fact.

Binding the grant to a digest is what answers that objection rather than
arguing with it. The user approves BYTES, not a name. Edit
``effects.js`` and the stored grant stops matching, so the prompt fires
again and the edited script runs only if it is approved on its own. That
turns "a yes on one device silently authorises another" into "a yes
authorises one artifact, everywhere", which is a materially different and
much smaller claim.

A DIGEST THAT COULD NOT BE TAKEN IS NOT A DIGEST OF NOTHING. Every
failure here answers ``None``, and the consent ladder treats ``None`` as
unverifiable and REFUSES. Answering with a digest of empty bytes, or with
the empty string, would make an unreadable file compare equal to another
unreadable file and hand a stale grant a match it did not earn.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Optional

import structlog

logger = structlog.get_logger()

DIGEST_ALGORITHM = "sha256"
"""Named once. The stored record carries only the hex, so a future second
algorithm would need its own field rather than a prefix nobody parses."""

MAX_EFFECTS_BYTES = 4 * 1024 * 1024
"""A theme effects module is a few kilobytes of animation code. Four
megabytes is a ceiling rather than a target: it stops a pathological file
turning a manifest scan into a long read, and a file over it answers
``None``, which REFUSES rather than silently running something the digest
never covered."""


def digest_file(path: Path) -> Optional[str]:
    """Hex ``sha256`` of one file's bytes, or ``None`` if it cannot be read.

    Description: reads in chunks so a large file does not land in memory
      whole, and refuses one over ``MAX_EFFECTS_BYTES`` outright. Every
      refusal answers ``None``, which the consent ladder reads as "this
      script cannot be verified" and turns into a refusal to run it.
    Inputs: path (Path) - the file to measure.
    Output: str|None - 64 lowercase hex characters, or None.

    Example:
        digest_file(Path("themes/matrix/effects.js"))
        -> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    """
    try:
        if not path.is_file():
            return None
        size = path.stat().st_size
    except OSError as exc:
        logger.warning("theme_effects_digest_stat_failed", path=str(path), error=str(exc))
        return None

    if size > MAX_EFFECTS_BYTES:
        logger.warning(
            "theme_effects_digest_too_large",
            path=str(path),
            size=size,
            limit=MAX_EFFECTS_BYTES,
        )
        return None

    hasher = hashlib.new(DIGEST_ALGORITHM)
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(65536), b""):
                hasher.update(chunk)
    except OSError as exc:
        logger.warning("theme_effects_digest_read_failed", path=str(path), error=str(exc))
        return None
    return hasher.hexdigest()


def digest_effects(theme_dir: Path, effects_filename: Optional[str]) -> Optional[str]:
    """Digest the ``effects.js`` a manifest names, refusing an unsafe name.

    Description: the filename comes out of a ``theme.json`` a user can
      author, so it is checked here as well as in the client's
      ``effectsUrlFor``. A name carrying a separator or a parent
      reference is refused rather than resolved, because the point of
      this value is to describe the exact file the client will fetch from
      ``/themes/<id>/<file>`` and that URL has no path shape either.
      A theme that declares no script answers ``None`` and so does one
      whose file cannot be read; the consent ladder tells those two apart
      by looking at whether the manifest declared a script at all.
    Inputs:
      theme_dir (Path) - the directory the manifest was loaded from.
      effects_filename (str|None) - the manifest's ``effects`` field.
    Output: str|None - the hex digest, or None when there is nothing to
      measure or it could not be measured.

    Example:
        digest_effects(Path("themes/matrix"), "effects.js")
    """
    if not effects_filename or not isinstance(effects_filename, str):
        return None
    if "/" in effects_filename or "\\" in effects_filename or ".." in effects_filename:
        logger.warning(
            "theme_effects_digest_rejected_name",
            theme_dir=str(theme_dir),
            reason="the effects filename must be a bare name in the theme directory",
        )
        return None
    return digest_file(theme_dir / effects_filename)
