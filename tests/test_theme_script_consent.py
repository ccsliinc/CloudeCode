"""The server half of theme script consent: the ladder, the digest, the store.

WHAT THIS FILE IS FOR. ``client/js/theme-consent.js`` is what actually
gates execution in a browser, and
``tests/test_theme_script_consent.node.mjs`` carries the negative controls
for it. This file proves the three things the SERVER is responsible for,
each of which would silently defeat that gate if it were wrong:

  1. The ladder here answers the same way the client's does, rung for
     rung. Two ladders that disagree are two policies.
  2. A digest is the digest OF THE BYTES SERVED, and a file that could not
     be read answers None rather than a digest of nothing - which would
     let two unreadable files compare equal and hand a stale grant a match
     it did not earn.
  3. The preference block REFUSES a record the gate could not safely act
     on: an ``always`` with no digest (an unbounded grant), and the word
     ``once`` (a temporary allowance being made standing).

The refusing cases outnumber the permitting one on purpose. A consent
model is only as good as what it declines.
"""

from __future__ import annotations

import pytest

from src.core import theme_script_consent as consent
from src.core import theme_script_digest as digest
from src.core import ui_preferences

DIGEST_A = "a" * 64
DIGEST_B = "b" * 64


def _decide(**overrides):
    """Call the ladder with a sane user-theme baseline."""
    spec = {
        "declares_script": True,
        "source": consent.SOURCE_USER,
        "served_digest": DIGEST_A,
        "record": None,
        "record_readable": True,
    }
    spec.update(overrides)
    return consent.decide(**spec)


# ---------------------------------------------------------------------
# The ladder. Only one rung runs.
# ---------------------------------------------------------------------


def test_a_theme_with_no_script_is_not_a_consent_question():
    verdict = _decide(declares_script=False)
    assert verdict.outcome == consent.SKIP_NO_SCRIPT
    assert verdict.may_run is False


def test_a_recorded_refusal_refuses():
    verdict = _decide(record={"decision": "never"})
    assert verdict.outcome == consent.SKIP_DENIED
    assert verdict.may_run is False


def test_a_refusal_outranks_the_bundled_bypass():
    """A builtin theme runs unprompted, but never over an explicit no."""
    allowed = _decide(source=consent.SOURCE_BUILTIN, record=None)
    assert allowed.may_run is True and allowed.rung == consent.RUNG_BUILTIN

    refused = _decide(source=consent.SOURCE_BUILTIN, record={"decision": "never"})
    assert refused.outcome == consent.SKIP_DENIED
    assert refused.may_run is False


def test_a_refusal_outranks_an_unreadable_record():
    """A no we DID manage to read is a fact; nothing below improves on it."""
    verdict = _decide(record={"decision": "never"}, record_readable=False)
    assert verdict.rung == consent.RUNG_DENIED


def test_an_unreadable_record_refuses_a_cached_grant():
    """The 'a cached approval cannot outrank a newer Never' rule.

    We cannot show that no newer refusal exists, so the grant does not
    run. The cost is an animation that does not play.
    """
    verdict = _decide(
        record={"decision": "always", "digest": DIGEST_A}, record_readable=False
    )
    assert verdict.outcome == consent.SKIP_UNVERIFIABLE
    assert verdict.rung == consent.RUNG_RECORD_UNREADABLE
    assert verdict.may_run is False


def test_a_user_theme_whose_bytes_could_not_be_named_never_runs():
    verdict = _decide(
        served_digest=None, record={"decision": "always", "digest": DIGEST_A}
    )
    assert verdict.outcome == consent.SKIP_UNVERIFIABLE
    assert verdict.rung == consent.RUNG_DIGEST_UNAVAILABLE


def test_a_malformed_digest_is_not_a_digest():
    verdict = _decide(served_digest="not-a-sha256")
    assert verdict.outcome == consent.SKIP_UNVERIFIABLE


def test_a_grant_covers_the_bytes_it_named_and_no_others():
    same = _decide(record={"decision": "always", "digest": DIGEST_A})
    assert same.may_run is True and same.rung == consent.RUNG_GRANTED

    edited = _decide(record={"decision": "always", "digest": DIGEST_B})
    assert edited.outcome == consent.PROMPT_CHANGED
    assert edited.may_run is False


def test_nothing_on_record_asks_rather_than_running():
    verdict = _decide(record=None)
    assert verdict.outcome == consent.PROMPT
    assert verdict.may_run is False


def test_an_unrecognised_source_is_treated_as_a_user_theme():
    """An unknown provenance is not a reason to trust something more."""
    verdict = _decide(source="somewhere-else", record=None)
    assert verdict.outcome == consent.PROMPT


def test_exactly_one_outcome_permits_execution():
    """A caller asks the set, not a list of refusals that can grow."""
    every = {
        consent.RUN,
        consent.SKIP_NO_SCRIPT,
        consent.SKIP_DENIED,
        consent.SKIP_UNVERIFIABLE,
        consent.PROMPT,
        consent.PROMPT_CHANGED,
    }
    assert consent.RUNNING_OUTCOMES == {consent.RUN}
    assert len(every) == 6


# ---------------------------------------------------------------------
# What may be stored.
# ---------------------------------------------------------------------


def test_allow_once_is_never_a_stored_record():
    assert consent.record_for("once", DIGEST_A) is None


def test_a_grant_with_no_digest_cannot_be_built():
    """An unbounded grant is refused where it would be constructed."""
    assert consent.record_for("always", None) is None
    assert consent.record_for("always", "short") is None
    assert consent.record_for("always", DIGEST_A) == {
        "decision": "always",
        "digest": DIGEST_A,
    }


def test_a_refusal_carries_no_digest():
    assert consent.record_for("never", DIGEST_A) == {"decision": "never"}


def test_the_preference_block_refuses_an_unbounded_grant():
    with pytest.raises(ValueError) as exc:
        ui_preferences.validate_changes(
            {"theme_script_consent": {"matrix": {"decision": "always"}}}
        )
    assert "digest" in str(exc.value)


def test_the_preference_block_refuses_the_word_once():
    with pytest.raises(ValueError) as exc:
        ui_preferences.validate_changes(
            {"theme_script_consent": {"matrix": {"decision": "once"}}}
        )
    assert "once" in str(exc.value)


def test_the_preference_block_accepts_a_bounded_grant_and_a_refusal():
    out = ui_preferences.validate_changes(
        {
            "theme_script_consent": {
                "matrix": {"decision": "always", "digest": DIGEST_A},
                "snes": {"decision": "never"},
            }
        }
    )
    assert out["theme_script_consent"] == {
        "matrix": {"decision": "always", "digest": DIGEST_A},
        "snes": {"decision": "never"},
    }


def test_a_refusal_does_not_keep_a_digest_it_was_sent():
    """Storing one would invite a later reader to scope the no to bytes."""
    out = consent.validate_consent_map(
        {"matrix": {"decision": "never", "digest": DIGEST_A}}
    )
    assert out["matrix"] == {"decision": "never"}


def test_a_consent_key_must_be_a_theme_id():
    with pytest.raises(ValueError):
        consent.validate_consent_map({"../etc/passwd": {"decision": "never"}})


def test_the_map_is_bounded():
    too_many = {
        f"t{i}": {"decision": "never"}
        for i in range(consent.MAX_CONSENT_ENTRIES + 1)
    }
    with pytest.raises(ValueError):
        consent.validate_consent_map(too_many)


# ---------------------------------------------------------------------
# Revocation.
# ---------------------------------------------------------------------


def test_only_a_move_into_a_refusal_is_a_revocation():
    assert consent.revocations_between({}, {"a": {"decision": "never"}}) == ("a",)
    assert (
        consent.revocations_between(
            {"a": {"decision": "never"}}, {"a": {"decision": "never"}}
        )
        == ()
    )
    assert (
        consent.revocations_between(
            {"a": {"decision": "always", "digest": DIGEST_A}}, {}
        )
        == ()
    )


# ---------------------------------------------------------------------
# The digest itself.
# ---------------------------------------------------------------------


def test_the_digest_is_of_the_bytes_on_disk(tmp_path):
    import hashlib

    theme = tmp_path / "matrix"
    theme.mkdir()
    (theme / "effects.js").write_bytes(b"export function init() {}\n")
    expected = hashlib.sha256(b"export function init() {}\n").hexdigest()
    assert digest.digest_effects(theme, "effects.js") == expected


def test_editing_the_file_moves_the_digest(tmp_path):
    """This is the whole reason a shared grant is safe to share."""
    theme = tmp_path / "matrix"
    theme.mkdir()
    script = theme / "effects.js"
    script.write_bytes(b"export function init() {}\n")
    before = digest.digest_effects(theme, "effects.js")
    script.write_bytes(b"export function init() { steal(); }\n")
    after = digest.digest_effects(theme, "effects.js")
    assert before != after

    # And the grant taken against the old bytes no longer runs the new
    # ones - measured through the ladder rather than asserted about it.
    verdict = consent.decide(
        declares_script=True,
        source=consent.SOURCE_USER,
        served_digest=after,
        record={"decision": "always", "digest": before},
    )
    assert verdict.may_run is False
    assert verdict.outcome == consent.PROMPT_CHANGED


def test_a_missing_file_answers_none_not_a_digest_of_nothing(tmp_path):
    theme = tmp_path / "matrix"
    theme.mkdir()
    assert digest.digest_effects(theme, "effects.js") is None


def test_a_theme_that_declares_no_script_answers_none(tmp_path):
    theme = tmp_path / "matrix"
    theme.mkdir()
    assert digest.digest_effects(theme, None) is None
    assert digest.digest_effects(theme, "") is None


def test_a_filename_with_a_path_in_it_is_refused(tmp_path):
    """The URL the client builds has no path shape either."""
    theme = tmp_path / "matrix"
    theme.mkdir()
    (theme / "effects.js").write_bytes(b"x")
    outside = tmp_path / "secret.js"
    outside.write_bytes(b"secret")
    assert digest.digest_effects(theme, "../secret.js") is None
    assert digest.digest_effects(theme, "sub/effects.js") is None


def test_an_oversized_script_answers_none(tmp_path, monkeypatch):
    theme = tmp_path / "matrix"
    theme.mkdir()
    (theme / "effects.js").write_bytes(b"x" * 128)
    monkeypatch.setattr(digest, "MAX_EFFECTS_BYTES", 16)
    assert digest.digest_effects(theme, "effects.js") is None
