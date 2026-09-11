"""What a theme id may be, and the two places that must agree about it.

THE DEFECT THIS FILE EXISTS FOR. ``ThemeManifest.id`` has no pattern
validation - the only rule is that it equals the directory name - so a
folder called ``Neon Rain`` is served by ``GET /themes`` intact, effects
script, digest and all. ``THEME_ID_RE`` then refused it, so clicking
"never" on that theme produced a 422 the browser reported as a recorded
refusal. It failed CLOSED, so nothing extra executed, but the decision was
gone on reload and never reached the user's other devices. A durability
lie on a consent control is its own defect: it teaches the user the
control does not work.

Two claims are measured here. First, that the charset covers the folder
names people really have while still refusing everything that can break a
path, a URL, a JSON key or a round trip. Second, that the rule has ONE
definition: ``ui_preferences`` carried its own duplicate of this pattern
and now imports it, and the test asserts the SAME OBJECT rather than two
equal patterns, so a future widening cannot reach one and miss the other.
The browser deliberately keeps no copy at all; see the note at the top of
``client/js/theme-consent.js``.
"""

from __future__ import annotations

import pytest

from src.core import theme_script_consent, ui_preferences

ACCEPTED = [
    pytest.param("matrix", id="a plain lowercase id"),
    pytest.param("claude", id="a bundled theme"),
    pytest.param("Neon Rain", id="a space, which is an ordinary folder name"),
    pytest.param("_lead", id="a leading underscore, which nothing treats specially"),
    pytest.param("a.b-c_d", id="the punctuation that was always allowed"),
    pytest.param("a  b", id="two spaces, which round trip fine"),
    pytest.param("ab", id="the shortest id with a last character"),
    pytest.param("a", id="one character"),
    pytest.param("x" * theme_script_consent.MAX_THEME_ID_LENGTH, id="exactly the cap"),
]

REFUSED = [
    pytest.param(
        "x" * (theme_script_consent.MAX_THEME_ID_LENGTH + 1), id="one over the cap"
    ),
    pytest.param("über", id="non-ascii: unreadable in the config audit record"),
    pytest.param("a​b", id="a zero-width space, invisible in two ids"),
    pytest.param("a‮b", id="a bidi override, which can spoof a name"),
    pytest.param(" lead", id="a leading space, invisible and trimmable"),
    pytest.param("trail ", id="a trailing space, invisible and trimmable"),
    pytest.param(".hidden", id="a leading dot, which the scanner skips anyway"),
    pytest.param(".", id="the current directory"),
    pytest.param("..", id="the parent directory, the traversal case"),
    pytest.param("-flag", id="a leading dash, one step from being argv"),
    pytest.param("a/b", id="a path separator"),
    pytest.param("a\\b", id="the other path separator"),
    pytest.param("a\x00b", id="NUL"),
    pytest.param("a\nb", id="an embedded newline"),
    pytest.param("matrix\n", id="a TRAILING newline, which '$' used to accept"),
    pytest.param("", id="empty"),
]


@pytest.mark.parametrize("theme_id", ACCEPTED)
def test_a_real_folder_name_can_be_keyed(theme_id: str) -> None:
    """A name a user would actually give a theme directory is keyable."""
    assert theme_script_consent.is_keyable_theme_id(theme_id)


@pytest.mark.parametrize("theme_id", REFUSED)
def test_an_unsafe_name_is_refused(theme_id: str) -> None:
    """Each refusal has a reason; the parametrize id names it."""
    assert not theme_script_consent.is_keyable_theme_id(theme_id)


def test_a_non_string_is_refused_rather_than_crashing() -> None:
    """The predicate is total. Callers hand it manifest data."""
    for value in (None, 123, [], {}, object()):
        assert not theme_script_consent.is_keyable_theme_id(value)


@pytest.mark.parametrize("theme_id", ACCEPTED)
def test_an_accepted_id_can_actually_record_a_refusal(theme_id: str) -> None:
    """The end the defect was reported at: does clicking never stick.

    ``is_keyable_theme_id`` answering True is not the claim; the claim is
    that ``validate_consent_map`` then takes the entry. A predicate that
    agreed with nothing downstream would pass the test above and leave the
    bug exactly where it was.
    """
    out = theme_script_consent.validate_consent_map(
        {theme_id: {"decision": "never"}}
    )
    assert out == {theme_id: {"decision": "never"}}


@pytest.mark.parametrize("theme_id", REFUSED)
def test_a_refused_id_is_still_refused_by_the_map(theme_id: str) -> None:
    """The negative control for the test above.

    A widening that accepted everything would make that test pass for any
    input at all, which is this project's "a matcher that always finds
    something is worse than useless" applied to a validator.
    """
    with pytest.raises(ValueError):
        theme_script_consent.validate_consent_map(
            {theme_id: {"decision": "never"}}
        )


def test_the_selected_theme_uses_the_same_rule_as_the_consent_key() -> None:
    """One rule, imported, not two that happen to look alike.

    ``ui_preferences`` carried its own copy of this pattern, so a folder
    name one accepted and the other refused was a theme the user could
    select and could not record a decision about. It is the SAME OBJECT
    now, which is stronger than equal patterns: a widening cannot reach one
    and miss the other.
    """
    assert ui_preferences.THEME_ID_RE is theme_script_consent.THEME_ID_RE


@pytest.mark.parametrize("theme_id", ACCEPTED)
def test_an_accepted_id_can_also_be_the_selected_theme(theme_id: str) -> None:
    """Both halves of one user action: pick the theme, answer its prompt."""
    values = ui_preferences.UiPreferenceValues(theme=theme_id)
    assert values.theme == theme_id
