"""Decide which of the two durable theme stores answers for a session.

A theme is pinned to a CONVERSATION, not to a folder. There are two
durable stores in this app and they are keyed on different things:

  * ``pinned_themes.json`` is keyed on the bare tmux NAME. It records a
    theme the user pinned to ONE session, by hand, from that session's
    own menu.
  * ``<working_dir>/.cc.theme`` is keyed on the DIRECTORY. It records the
    default a PROJECT carries, so a checkout has its colours before any
    session exists, and so a user can commit one or hand it to somebody.

BOTH STORES ARE WANTED. What is not wanted is one silently overriding
the other, which is what shipped until 2026-09-10: the directory-keyed
dotfile was read FIRST, so a per-session pin was discarded without a log
line on every server restart and every boot re-adopt, and two sessions
sharing one folder could never hold two different themes. The pin was
still sitting in ``pinned_themes.json`` the whole time and was never
read.

THE RULE IS THE ONE ``session_agent_evidence`` ALREADY STATES OUT LOUD:
a value written ABOUT this session outranks a value written about the
place it happens to live. The pin is the record. The dotfile is the
default. A default must lose to an explicit choice, or it is not a
default, it is an override.

This module is PURE. It performs no I/O and knows nothing about paths,
tmux or the manager: callers read each store and hand the two answers
in. That is what makes the ladder testable on its own and what keeps
one ordering from being re-implemented at each of the three seeding call
sites (create, adopt, boot re-adopt).
"""

from dataclasses import dataclass
from typing import Optional

# Which rung of the ladder answered. Mirrors the shape of
# ``agent_family_source``: the value alone cannot say whether it was a
# deliberate per-session choice or a folder-wide default, and a log line
# or a future UI that could not tell them apart would be describing two
# different facts with one word.
THEME_SOURCE_PIN = "pin"
THEME_SOURCE_PROJECT_DEFAULT = "project_default"
THEME_SOURCE_NONE = "none"


@dataclass(frozen=True)
class ThemeResolution:
    """The effective theme for a session, plus which store it came from.

    Attributes:
        theme_id: The theme to paint, or None when neither store holds
            one. None means "paint the app default", NOT "the stores
            could not be read" - see ``resolve_theme``.
        source: One of ``THEME_SOURCE_PIN``,
            ``THEME_SOURCE_PROJECT_DEFAULT`` or ``THEME_SOURCE_NONE``.
    """

    theme_id: Optional[str]
    source: str


def resolve_theme(
    pinned: Optional[str],
    project_default: Optional[str],
) -> ThemeResolution:
    """Pick the effective theme from the two stores' answers.

    The ladder, in order:

      1. ``pinned`` - the per-session pin for this tmux name. An explicit
         choice the user made about THIS conversation.
      2. ``project_default`` - the directory's ``.cc.theme``. Reached
         only by a session that has never been pinned.
      3. None.

    A blank string in either store is treated as absent, because that is
    what both readers already produce for an empty file or an empty JSON
    value, and a caller should never have to ask which kind of nothing it
    was handed.

    NOTE ON A STORE THAT COULD NOT BE READ: neither argument can express
    "I did not look", and that is deliberate. Both readers already refuse
    to invent a value - an unreadable dotfile and an unloadable JSON map
    each yield None here - so the worst this ladder can do is fall
    through to the next rung, never to a fabricated answer. Refusing to
    CLOBBER an unreadable store is a separate problem and it is solved
    where the writing happens, in ``SessionManager._save_pinned_themes``.

    Args:
        pinned: The per-session pin, or None when this session has none.
        project_default: The directory's default, or None when the folder
            carries none.

    Returns:
        A ``ThemeResolution`` naming the theme and the rung that answered.

    Example:
        >>> resolve_theme(pinned="dracula", project_default="snes").theme_id
        'dracula'
        >>> resolve_theme(pinned=None, project_default="snes").theme_id
        'snes'
        >>> resolve_theme(pinned=None, project_default=None).source
        'none'
    """
    if pinned:
        return ThemeResolution(theme_id=pinned, source=THEME_SOURCE_PIN)
    if project_default:
        return ThemeResolution(
            theme_id=project_default,
            source=THEME_SOURCE_PROJECT_DEFAULT,
        )
    return ThemeResolution(theme_id=None, source=THEME_SOURCE_NONE)
