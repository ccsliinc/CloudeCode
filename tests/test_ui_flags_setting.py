"""The `ui` config block: the owner's show/hide switches for client surfaces.

Behaviour, not implementation. Every flag in this block hides something
that SHIPS, so the properties worth asserting are the ones that decide
whether a capability can disappear by accident:

  - the default is ON, so an install that upgrades keeps the control;
  - a config.json with no `ui` key at all loads and still says ON, which
    is every config written before 2026-09-09;
  - an explicit false round-trips, so the switch actually switches;
  - the settings summary carries the block, so the settings screen can
    show and change it.

Background: `ui.show_mark_unread_control` gates the manual "mark this
session unread for followup" toggle. One line of this project deleted
that control outright on the grounds that the LED's green finished-turn
ring already says a session is unread. The owner's rule, verbatim, is
"when clicking a tab, the session is marked read. if i want it unread i
click unread" - the indicator and the control are two different things -
so the control was kept and put behind this flag instead.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
# Same pattern as tests/test_agent_families.py: every module that touches
# src.config bootstraps its own, because src.config validates .env at
# IMPORT time and calls sys.exit(1) when a required field is missing.
os.environ.setdefault("CLOUDE_STATE_DIR", tempfile.mkdtemp(prefix="cc_uiflags_state_"))
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_uiflags_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_uiflags_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.config import AuthConfig, Settings, UIConfig


def test_the_control_is_shown_by_default():
    """A bare UIConfig shows the control.

    This is the whole safety property of the block: the default must be
    the shipped behaviour, or adding a flag removes a feature.
    """
    assert UIConfig().show_mark_unread_control is True


def test_a_config_with_no_ui_key_still_shows_the_control():
    """Every config.json written before 2026-09-09 has no `ui` key.

    Those installs must load unchanged and keep the control. A missing
    section is not a request to hide anything.
    """
    cfg = AuthConfig()
    assert "ui" not in cfg.model_dump(exclude_unset=True)
    assert cfg.ui.show_mark_unread_control is True


def test_an_explicit_false_round_trips_through_json():
    """The switch switches, and survives the write/read cycle.

    Serialized and parsed back the way config.json is, because a flag
    that only holds in memory is not a setting.
    """
    written = AuthConfig(ui={"show_mark_unread_control": False})
    assert written.ui.show_mark_unread_control is False

    reread = AuthConfig(**json.loads(json.dumps(written.model_dump())))
    assert reread.ui.show_mark_unread_control is False


def test_an_explicit_true_round_trips_too():
    """The other direction, because a default is not a measurement.

    A flag that reads True whatever is on disk would pass the test above
    by accident.
    """
    reread = AuthConfig(
        **json.loads(json.dumps(AuthConfig(ui={"show_mark_unread_control": True}).model_dump()))
    )
    assert reread.ui.show_mark_unread_control is True


def test_an_unknown_ui_key_does_not_break_the_load():
    """A newer build's flag must not stop an older one from starting.

    The `ui` block is where client switches will accumulate, so a config
    written by a build that knows more of them has to load here.
    """
    cfg = AuthConfig(ui={"show_mark_unread_control": False, "some_future_flag": True})
    assert cfg.ui.show_mark_unread_control is False


def _settings(tmp_path, ui=None):
    """Build a Settings pointed at a throwaway config.json.

    Same helper shape as tests/test_universal_wrapper_resolution.py, for
    the same reason: get_settings_summary reads the real config file, so
    a test that wants to assert what the settings screen receives has to
    give it one.

    Inputs:
      tmp_path (Path) - pytest tmp dir.
      ui (dict|None) - the `ui` block to write, or None to omit it.
    Output: Settings.
    """
    body = {"config_version": 3}
    if ui is not None:
        body["ui"] = ui
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(body))
    return Settings(
        default_working_dir=str(tmp_path),
        log_directory=str(tmp_path / "logs"),
        totp_secret="x",
        jwt_secret="y",
        auth_config_file=str(config_path),
    )


def test_the_settings_summary_carries_the_block(tmp_path):
    """`GET /api/v1/config/settings` reports it, so the screen can edit it.

    Asserted against the real assembler rather than a hand-built dict:
    the point is that the summary is wired to the config, not that a
    dict has a key.
    """
    summary = _settings(tmp_path).get_settings_summary()
    assert "ui" in summary
    assert summary["ui"]["show_mark_unread_control"] is True


def test_the_settings_summary_reports_the_stored_value_not_the_default(tmp_path):
    """The NEGATIVE control, and it is the one that matters.

    A summary that hardcoded True would pass the test above perfectly
    and report the opposite of what is on disk, which is exactly how a
    settings screen comes to show a switch that does nothing.
    """
    summary = _settings(
        tmp_path, ui={"show_mark_unread_control": False}
    ).get_settings_summary()
    assert summary["ui"]["show_mark_unread_control"] is False


def test_a_config_file_with_no_ui_key_summarises_as_shown(tmp_path):
    """The upgrade case, end to end through the real file reader."""
    summary = _settings(tmp_path, ui=None).get_settings_summary()
    assert summary["ui"]["show_mark_unread_control"] is True


def test_the_client_actually_probes_the_flag():
    """A SETTING NOTHING READS IS NOT A SETTING, and the failure is silent.

    `client/js/ui-flags.js` answers every flag's DEFAULT until its probe
    lands, which is correct and is also exactly how a flag can ship dead:
    with no caller for `ensure()`, `showMarkUnreadControl()` returns true
    forever and `ui.show_mark_unread_control: false` is a config key
    nothing reads. Nothing fails, no error is logged, and the switch
    simply does not work.

    So this asserts the CALLER exists, on both surfaces that render the
    control, because either can be the first one a page load reaches.
    A source-text check is the right shape here: the property under test
    is "some live code path calls this", and a unit test of the module
    itself cannot see that.
    """
    from pathlib import Path

    client_js = Path(__file__).resolve().parents[1] / "client" / "js"
    for name in ("session-sidebar-fetch.js", "launchpad.js"):
        src = (client_js / name).read_text(encoding="utf-8")
        assert "UIFlags.ensure" in src, (
            f"{name} must probe the UI flags, or the setting never reaches "
            "the client and fails silently"
        )

    # And the module must actually be served, or the guard above is
    # checking a call into nothing.
    index = (client_js.parent / "index.html").read_text(encoding="utf-8")
    assert "/static/js/ui-flags.js" in index
