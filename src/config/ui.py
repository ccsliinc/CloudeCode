"""The UI block, and the ``config.json`` key it lives under.

Carved out of the flat ``src/config.py`` by slice S5. Bodies byte-exact."""

from pydantic import BaseModel


# The config.json key the UI switches live under. Named once, imported
# rather than spelled twice, the same way WORKSPACE_KEY and
# SERVER_PREFS_KEY are in src/core/workspace_settings.py.
UI_KEY = "ui"


class UIConfig(BaseModel):
    """Client-side surfaces the owner can switch off.

    ADDITIVE AND DEFAULT-ON. Every flag here hides something that ships
    enabled, so a config.json predating this block loads with the app
    exactly as it was. A flag that defaulted to False would silently
    remove a capability from every install that upgraded.

    ``show_mark_unread_control`` is the manual "mark this session unread
    for followup" toggle on the sidebar row and the launchpad card. The
    LED's green finished-turn ring already SAYS a session is unread; this
    is the control that SETS it, which is a different thing. The owner's
    rule, verbatim: "when clicking a tab, the session is marked read. if i
    want it unread i click unread." One line of this project deleted the
    control on the grounds that the indicator made it redundant; the owner
    kept it and asked for a switch instead, 2026-09-09. Unread TRACKING is
    untouched by this flag either way - `PATCH /sessions/{name}/unread`
    still exists and the LED still paints the state.

    Fields:
        show_mark_unread_control: Whether the manual unread toggle is
            rendered. True (shown) unless explicitly set to false.
    """

    show_mark_unread_control: bool = True
