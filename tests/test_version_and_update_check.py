"""Tests for the release-tag version resolver and the update self check.

The behaviour that matters most here is the THIRD OUTCOME: when the checker
cannot look at the remote it must say so, and must never report "current".
Every test that exercises a failure asserts the status is ``unknown`` and
that a reason was recorded.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.core import update_check
from src.core.update_check import (
    STATUS_CURRENT,
    STATUS_UNKNOWN,
    STATUS_UPDATE_AVAILABLE,
    UpdateCheckError,
    UpdateChecker,
    parse_version,
    read_configured_remote,
)
from src.core.version import (
    VERSION_FILE_HEADER,
    normalize_tag,
    read_version_file,
    resolve_version,
    write_version_file,
)


# --- version resolution ---------------------------------------------------


def test_normalize_tag_strips_v_and_whitespace() -> None:
    assert normalize_tag(" v1.2.3 ") == "1.2.3"
    assert normalize_tag("1.2.3") == "1.2.3"
    assert normalize_tag("") == ""


def test_version_file_round_trip(tmp_path: Path) -> None:
    write_version_file("v2.3.4", root=tmp_path)
    text = (tmp_path / "VERSION").read_text(encoding="utf-8")
    assert text.startswith(VERSION_FILE_HEADER)
    assert read_version_file(tmp_path) == "2.3.4"


def test_version_file_missing_returns_empty(tmp_path: Path) -> None:
    assert read_version_file(tmp_path) == ""


def test_env_var_wins_over_version_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_version_file("1.0.0", root=tmp_path)
    monkeypatch.setenv("CLOUDE_APP_VERSION", "v9.9.9")
    assert resolve_version(tmp_path) == "9.9.9"


def test_version_file_used_when_env_absent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CLOUDE_APP_VERSION", raising=False)
    write_version_file("1.0.0", root=tmp_path)
    assert resolve_version(tmp_path) == "1.0.0"


def test_resolve_returns_empty_when_nothing_available(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An empty directory resolves to "" so callers render nothing.

    Blank is the correct answer; a wrong literal is not.
    """
    monkeypatch.delenv("CLOUDE_APP_VERSION", raising=False)
    assert resolve_version(tmp_path) == ""


# --- tag parsing ----------------------------------------------------------


@pytest.mark.parametrize(
    "tag,expected",
    [
        ("v1.2.3", (1, 2, 3)),
        ("1.2.3", (1, 2, 3)),
        ("v0.10.0", (0, 10, 0)),
        ("v1.2.3-rc1", None),
        ("0.8.1-3-gabc1234", None),
        ("nightly", None),
        ("", None),
    ],
)
def test_parse_version(tag: str, expected: tuple[int, int, int] | None) -> None:
    assert parse_version(tag) == expected


def test_read_configured_remote(tmp_path: Path) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"updates": {"remote": "https://example.test/x.git"}}))
    assert read_configured_remote(config) == "https://example.test/x.git"


def test_read_configured_remote_absent_or_malformed(tmp_path: Path) -> None:
    missing = tmp_path / "nope.json"
    assert read_configured_remote(missing) == ""
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    assert read_configured_remote(bad) == ""
    no_block = tmp_path / "plain.json"
    no_block.write_text(json.dumps({"projects": []}))
    assert read_configured_remote(no_block) == ""


# --- the three outcomes ---------------------------------------------------


def _checker(tmp_path: Path) -> UpdateChecker:
    """Build a checker wired entirely at temp paths.

    Args:
        tmp_path: pytest temp directory.

    Returns:
        An UpdateChecker whose config, repo root and cache all live under
        tmp_path so no test touches the real install.
    """
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"updates": {"remote": "https://example.test/x.git"}}))
    return UpdateChecker(
        config_path=config,
        root=tmp_path,
        cache_path=tmp_path / "cache.json",
    )


def test_outcome_current(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CLOUDE_APP_VERSION", raising=False)
    write_version_file("1.2.3", root=tmp_path)
    monkeypatch.setattr(update_check, "fetch_remote_tags", lambda remote: ["1.2.2", "1.2.3"])
    status = _checker(tmp_path).refresh()
    assert status.status == STATUS_CURRENT
    assert status.latest_version == "1.2.3"
    assert status.reason == ""


def test_outcome_update_available(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CLOUDE_APP_VERSION", raising=False)
    write_version_file("1.2.3", root=tmp_path)
    monkeypatch.setattr(
        update_check, "fetch_remote_tags", lambda remote: ["1.2.3", "1.10.0", "1.9.0"]
    )
    status = _checker(tmp_path).refresh()
    assert status.status == STATUS_UPDATE_AVAILABLE
    # 1.10.0 beats 1.9.0: the sort is numeric, not lexical.
    assert status.latest_version == "1.10.0"
    assert status.upgrade_command


def test_outcome_unknown_when_remote_unreachable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unreachable remote is UNKNOWN, never CURRENT. This is the whole point."""
    monkeypatch.delenv("CLOUDE_APP_VERSION", raising=False)
    write_version_file("1.2.3", root=tmp_path)

    def boom(remote: str) -> list[str]:
        raise UpdateCheckError("could not reach the release remote: offline")

    monkeypatch.setattr(update_check, "fetch_remote_tags", boom)
    status = _checker(tmp_path).refresh()
    assert status.status == STATUS_UNKNOWN
    assert status.status != STATUS_CURRENT
    assert "offline" in status.reason
    assert status.latest_version == ""


def test_outcome_unknown_when_version_unresolvable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("CLOUDE_APP_VERSION", raising=False)
    monkeypatch.setattr(update_check, "fetch_remote_tags", lambda remote: ["9.9.9"])
    status = _checker(tmp_path).refresh()
    assert status.status == STATUS_UNKNOWN
    assert status.reason


def test_outcome_unknown_when_not_on_a_release_tag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CLOUDE_APP_VERSION", "1.2.3-4-gdeadbee")
    monkeypatch.setattr(update_check, "fetch_remote_tags", lambda remote: ["1.2.3"])
    status = _checker(tmp_path).refresh()
    assert status.status == STATUS_UNKNOWN
    assert "release tag" in status.reason


def test_outcome_unknown_when_remote_has_no_release_tags(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("CLOUDE_APP_VERSION", raising=False)
    write_version_file("1.2.3", root=tmp_path)
    monkeypatch.setattr(update_check, "fetch_remote_tags", lambda remote: [])
    status = _checker(tmp_path).refresh()
    assert status.status == STATUS_UNKNOWN


def test_status_is_cached_and_reloaded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CLOUDE_APP_VERSION", raising=False)
    write_version_file("1.2.3", root=tmp_path)
    monkeypatch.setattr(update_check, "fetch_remote_tags", lambda remote: ["2.0.0"])
    first = _checker(tmp_path)
    first.refresh()
    # A brand new checker over the same cache path sees the stored answer,
    # with its timestamp, without touching the network.
    reloaded = _checker(tmp_path).status()
    assert reloaded.status == STATUS_UPDATE_AVAILABLE
    assert reloaded.checked_at > 0


def test_malformed_cache_is_not_a_passing_check(tmp_path: Path) -> None:
    """A corrupt cache must degrade to "no check has run yet", not to current."""
    (tmp_path / "cache.json").write_text("{ garbage")
    assert _checker(tmp_path).status().status == STATUS_UNKNOWN


def test_configured_remote_overrides_origin(tmp_path: Path) -> None:
    assert _checker(tmp_path).resolve_remote() == "https://example.test/x.git"
