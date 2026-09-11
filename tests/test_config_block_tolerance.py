"""A mangled block in config.json costs that block and nothing else.

Slice S5 of ``.claude/notes/backend-decomposition-plan.md`` collapsed
twelve copies of the malformed-block pattern into
``src.config.auth_loader.parse_block``. **THAT PATH HAD NO TESTS AT ALL**
- measured before the collapse: 21 test files touch ``load_auth_config``
and NOT ONE asserts any of the twelve ``invalid_*_config_block`` warnings
or the fallback behind them. So the tolerance every one of those blocks
depends on had never been observed to work, which is exactly the shape of
the guard this project has already paid for once: 4,874 green tests had
never seen ``ensure_pipe_pane``'s guard raise, and it failed 20 of 20
owned sessions on its first real boot.

**THE FALLBACK DIRECTION IS A DECISION AND THE TWO EXTREMES POINT
OPPOSITE WAYS.** A mangled ``message_archive`` yields ``enabled=False``,
the safe direction, matching what ``message_archive_flag.resolve()``
answers for the same input. A mangled ``ui`` yields the ALL-DEFAULT
object, which SHOWS every control, because an unparseable block must not
be able to hide a capability. Both are asserted here, because a helper
that returned "the model's defaults" without anyone checking WHICH
defaults would satisfy a reader and still be wrong for one of them.

**AND THE NEGATIVE CONTROL IS LOAD-BEARING.** A tolerance that accepted
everything would pass every positive case above and would mean a typo in
a block silently became that block's defaults with no warning at all. So
a VALID block must round-trip its values, and the rejection must LOG.

Run with:
    ./venv/bin/python3 -m pytest tests/test_config_block_tolerance.py -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_cbt_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_cbt_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.config.auth_loader import load, parse_block
from src.config.session import SessionConfig
from src.config.ui import UIConfig
from src.config.workspace import WorkspaceConfig

#: A value no block model can coerce: a list where a mapping is required.
GARBAGE = ["not", "a", "mapping"]


def _config(tmp_path: Path, **blocks) -> Path:
    """Write a minimal config.json carrying the given top-level blocks.

    Inputs: tmp_path (Path); blocks - top-level keys to include.
    Output: Path - the written file.
    Example: _config(tmp_path, ui={"show_x": "nonsense"})
    """
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"config_version": 1, **blocks}))
    return path


def _load(path: Path):
    """Load a config with the two secrets supplied, as Settings would."""
    return load(path, totp_secret="t" * 16, jwt_secret="j" * 16)


# --------------------------------------------------------------------------- #
# 1. parse_block itself                                                        #
# --------------------------------------------------------------------------- #


def test_a_valid_block_round_trips_its_values():
    """THE NEGATIVE CONTROL. Tolerance that accepts everything is useless."""
    parsed = parse_block(
        SessionConfig, {"disable_alternate_screen": True}, event="unused"
    )

    assert parsed.disable_alternate_screen is True


def test_a_mangled_block_becomes_defaults_and_says_so():
    """A rejection is LOGGED under its named event, never silent.

    Description: captured through structlog's own testing capture rather
      than ``caplog``, because this package logs through structlog and a
      stdlib handler may or may not be wired to it depending on what has
      configured logging first. Capturing at the source is the only read
      that is true in every run order.
    """
    from structlog.testing import capture_logs

    with capture_logs() as logs:
        parsed = parse_block(
            SessionConfig, GARBAGE, event="invalid_session_config_block"
        )

    assert parsed == SessionConfig()
    assert [e for e in logs if e["event"] == "invalid_session_config_block"]


def test_a_workspace_rejection_logs_key_names_and_never_a_value():
    """A workspace env VALUE can be a secret, so only keys may be logged."""
    from structlog.testing import capture_logs

    from src.config.auth_loader import _keys_only_payload

    with capture_logs() as logs:
        parse_block(
            WorkspaceConfig,
            {"env": "hunter2-this-is-the-secret"},
            event="invalid_workspace_config_block",
            payload=_keys_only_payload,
        )

    rejections = [
        e for e in logs if e["event"] == "invalid_workspace_config_block"
    ]
    assert rejections
    assert "hunter2-this-is-the-secret" not in repr(rejections), (
        "a workspace value reached the log; that value can be a secret"
    )
    assert rejections[0]["keys"] == ["env"]


# --------------------------------------------------------------------------- #
# 2. Through the real loader, block by block                                   #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "key,attribute",
    [
        ("session", "session"),
        ("auth_rate_limits", "auth_rate_limits"),
        ("notifications", "notifications"),
        ("agents", "agents"),
        ("uploads", "uploads"),
        ("providers", "providers"),
        ("message_archive", "message_archive"),
        ("workspace", "workspace"),
        ("server_prefs", "server_prefs"),
        ("ui", "ui"),
    ],
)
def test_one_mangled_block_costs_only_that_block(tmp_path, key, attribute):
    """Every other block still loads, which is the whole point.

    Description: the file carries ONE garbage block and one good marker
      elsewhere. If the tolerance were missing, the load would raise and
      the server would not start over a single hand-edited key.
    """
    path = _config(tmp_path, **{key: GARBAGE}, template_path="/tmp/marker")

    config = _load(path)

    assert getattr(config, attribute) is not None
    assert config.template_path == "/tmp/marker", (
        f"a mangled {key!r} block took the rest of the config with it"
    )


def test_a_mangled_message_archive_lands_on_the_SAFE_side(tmp_path):
    """Disabled, matching what message_archive_flag answers for the same input."""
    config = _load(_config(tmp_path, message_archive=GARBAGE))

    assert config.message_archive.enabled is False


def test_a_mangled_ui_block_cannot_hide_a_capability(tmp_path):
    """The ALL-DEFAULT object, which SHOWS every control.

    Description: the opposite direction from message_archive above, and
      deliberately so. An unparseable block must not be able to switch a
      surface off, because the user would have no way to switch it back.
    """
    config = _load(_config(tmp_path, ui=GARBAGE))

    assert config.ui == UIConfig()


def test_a_mangled_terminal_commands_block_falls_back_to_the_seeds(tmp_path):
    """Never an empty terminal tab, which is what an empty list would give."""
    config = _load(_config(tmp_path, terminal_commands=[{"bad": "entry"}]))

    assert config.terminal_commands, "the terminal tab would render empty"


def test_an_absent_terminal_commands_block_also_gets_the_seeds(tmp_path):
    """A config written before the feature existed still has a list."""
    config = _load(_config(tmp_path))

    assert config.terminal_commands


# --------------------------------------------------------------------------- #
# 3. What tolerance must NOT cover                                             #
# --------------------------------------------------------------------------- #


def test_a_missing_file_is_refused_not_tolerated(tmp_path):
    """Block tolerance is about one KEY, never about the file."""
    with pytest.raises(FileNotFoundError):
        _load(tmp_path / "nope.json")


def test_invalid_json_is_refused_and_names_the_file(tmp_path):
    """A file that will not parse has no blocks to be tolerant about."""
    path = tmp_path / "config.json"
    path.write_text("{ this is not json")

    with pytest.raises(ValueError) as caught:
        _load(path)

    assert str(path) in str(caught.value)


def test_a_missing_secret_is_refused(tmp_path):
    """Secrets come from .env and their absence is fatal, not a default."""
    with pytest.raises(ValueError):
        load(_config(tmp_path), totp_secret=None, jwt_secret="j" * 16)
