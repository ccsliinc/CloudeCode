---
party: ccsliinc
id: ccsliinc-session-row-menu
title: the session row menu and the plugin surface registry
branch: feat/svelte-1.3
opened: 2026-09-10
refreshed: 2026-09-10
expires: 2026-09-13
status: active
paths: web/src/lib/plugins/*.ts web/src/lib/plugins/mark-unread/*.ts client/js/session-row-menu.js client/js/session-sidebar-clicks.js client/js/session-sidebar.js client/js/session-status-ui.js tests/test_session_sidebar_rows.node.mjs
---

# the session row menu and the plugin surface registry

## approach

the row menu stops being a hardcoded list of buttons and becomes a RENDER of a
typed, build-time surface registry. an action is a plugin that declares its id,
label, surfaces and availability; the menu asks the registry what to show. mark
unread is the first plugin ported, as the proof.

the invariant we assume: an action's AVAILABILITY is data on the plugin, not a
branch in the menu. an unavailable action stays focusable and explains itself
rather than vanishing, so the menu's shape does not move under the user.

expects to change SHARED semantics, and this is the part to read: the row menu
becomes a svelte component fed by the registry, and client/js/session-row-menu.js
becomes a shim. anything that adds an action by editing that file directly is
adding it to the layer we are deleting.

## detail

Landed on `feat/svelte-1.3` as `2d43339`, on top of `5149118` (vite + svelte 5 +
typescript + tailwind) and `36a8a18` (the attribution prompt ported).

Registry, types and the first plugin are under `web/src/lib/plugins/`:
`registry.ts`, `types.ts`, `session-card-actions.ts`, `builtin.ts`,
`mark-unread/index.ts`, with vitest beside each.

**Direct overlap with `docs/webui-performance-and-session-menu-plan.md`, which
we have read.** Your plan replaces the live-session X with a shared vertical
three dot menu carrying rename / fork / new session in folder / mute / close,
with shortcut letters and full keyboard semantics. We have no objection to any
of that; the five actions and the keyboard model are better specified than
anything we wrote.

**What we would happily hand over:** the entire menu specification. Labels,
shortcuts, focus handling, viewport constraint, the separator above close, the
row-identity capture. Yours is better. We would rather implement your spec on
top of the registry than argue for ours.

**What we would rather you not rewrite this week:** `web/src/lib/plugins/`
itself, and specifically the shape of `types.ts`. If the five actions from your
plan are each expressed as a plugin, both designs are the same thing and neither
of us loses work. If the menu is rebuilt as a hardcoded component in
`client/js/`, one of the two gets thrown away.

**The concrete ask:** mute is a new action, and it is the natural second plugin.
If you are building it anyway, building it as a plugin costs you about the same
and costs us nothing.
