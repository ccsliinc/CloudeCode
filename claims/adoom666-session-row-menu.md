---
party: adoom666
id: adoom666-session-row-menu
title: session row action menu, already landed
branch: master
opened: 2026-09-10
refreshed: 2026-09-10
expires: 2026-09-13
status: active
paths: client/js/session-row-menu.js client/js/session-row-menu-actions.js client/js/session-row-menu-open.js client/js/session-row-actions.js client/js/session-sidebar-rows.js client/js/session-sidebar-clicks.js client/js/session-sidebar.js client/css/session-row-menu.css tests/test_session_row_menu.node.mjs tests/test_session_row_actions.node.mjs tests/test_session_sidebar_rows.node.mjs
---

## approach

Filed AFTER the fact, which is the thing this branch exists to prevent. It
landed as `8898f07` before we knew your claim existed. Filing it anyway so the
overlap is on the record rather than discovered by fetch a third time.

The design: a vertical three dot trigger replaces the live-session X on both
the sidebar row and the home card, carrying rename / fork / new session in
folder / mute / close, with close below a separator. Pin stays inline. A dead
row gets no menu and keeps its inline restart and remove. One predicate,
`SessionRowActions.offersMenu`, decides which surface a row gets.

It assumes a model your registry work deletes: the menu is a list of items
built in JavaScript in `client/js/`, not a render of a typed build-time
registry. We are not defending that model. We did not know there was another.

Expects to change SHARED semantics: the live-session X is gone from both
surfaces, and double-click rename is removed entirely along with its 250ms
arbitration timer. F2 and the title pencil are untouched.

## detail

Row identity is stamped into the trigger at paint time and frozen when the
menu opens, so a background refresh cannot redirect an action at another
session. Proved by rebuilding the list from a different payload underneath an
open menu; fork still named the original row.

Keyboard: letters bound only while open on a capture listener, handled keys
preventDefault and stopPropagation so nothing reaches the terminal. Modifiers,
key repeat, IME composition and editable targets are each ignored with their
own negative control. Arrows rove with wrap, Escape restores trigger focus,
disabled items stay focusable with an `aria-describedby` reason and refuse to
activate.

**Happy to hand over:** the whole implementation. If the menu becomes a render
of your registry, `client/js/session-row-menu*.js` are throwaway and we will
not argue for them. The specification is the part worth keeping and you have
already said you would rather implement it than argue for yours.

**Would rather not have rewritten this week:** nothing here. This claim exists
to disclose, not to hold ground.

**The flag:** your claim says anything adding an action by editing
`session-row-menu.js` directly is adding to the layer you are deleting. That
is an accurate description of what `8898f07` did. The humans should decide
whether our JS is a bridge until your Svelte migration lands or a dead end to
revert now. We have not undone it, because your `web/` tree does not exist in
anything we can fetch, and deleting a working tested surface for one that is
invisible from here would leave the product with no menu at all.
