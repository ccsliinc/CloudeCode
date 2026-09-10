"""No module but ``config_writer`` may write config.json.

This is issue #43's own verification grep turned into a test, because a
grep in an issue body is run once by the person who wrote it and a test
is run by everybody afterwards. ONE WRITER LEFT OUTSIDE THE BOUNDARY
REINTRODUCES THE LOST UPDATE, and it will be the one nobody tested.

It is scoped to config.json ON PURPOSE. The tree has several other
atomic writers - the hook token store, the unread store, the session
metadata file, the generic JSON artifact helper, the user-config file
editor - and every one of them writes a DIFFERENT file. They are not in
scope: what this test protects is the one document five functions used
to race each other over.
"""

from __future__ import annotations

import re
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"

# The module that IS the boundary, plus the one that only documents the
# path it hands to it.
ALLOWED = {"config_writer.py"}

# A line performing the tail of the write pattern.
WRITE_MARKERS = re.compile(r"os\.replace\(|\.suffix \+ \"\.bak\"|\.suffix \+ '\.bak'")

# The file being written, however the module spells it.
CONFIG_TARGETS = re.compile(r"config_path|config\.json")


def _python_files():
    return sorted(path for path in SRC.rglob("*.py") if path.name not in ALLOWED)


def test_only_config_writer_performs_a_config_json_write():
    offenders = []
    for path in _python_files():
        lines = path.read_text().splitlines()
        for number, line in enumerate(lines, start=1):
            stripped = line.strip()
            if stripped.startswith("#") or not WRITE_MARKERS.search(line):
                continue
            # Look at the surrounding function body, not the single line:
            # a writer names its target a few lines above the replace.
            window = "\n".join(lines[max(0, number - 25) : number + 2])
            if CONFIG_TARGETS.search(window):
                offenders.append(f"{path.relative_to(SRC.parent)}:{number}: {stripped}")

    assert not offenders, (
        "these lines write config.json outside src/core/config_writer.py:\n  "
        + "\n  ".join(offenders)
        + "\n\nEvery config.json writer goes through config_writer.commit(), or "
        "two of them arriving together lose one of the two updates."
    )


def test_the_boundary_itself_still_carries_the_write_pattern():
    """The POSITIVE CONTROL.

    A test that only looks for the pattern's absence would pass just as
    happily if the pattern were deleted everywhere, boundary included -
    which would mean config.json had stopped being written atomically at
    all. This asserts the sequence is still there, in order.
    """
    source = (SRC / "core" / "config_writer.py").read_text()
    backup = source.index('.suffix + ".bak"')
    fsync = source.index("os.fsync(")
    replace = source.index("os.replace(")

    assert backup < fsync < replace, (
        "the write sequence must stay .bak of the pre-write bytes, then temp "
        "file, then fsync, then os.replace"
    )
