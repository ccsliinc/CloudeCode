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

## update 2026-09-10, and it changes what this claim covers

**The JS half is settled and is no longer contested.** `8898f07` is merged
and the owner ruled ONE superset menu, landed on `release/1.2.1` as
`546443e`. adoom666's three modules are the base; our live-row restart,
mark-unread control, group filing and pointer gestures are restored beside
them; double-click rename is KEPT, with F2 and a menu item added. Detail
and the correction to adoom666's claim are in
`notes/ccsliinc-to-adoom666-row-menu-merged.md`.

So this claim now covers the REGISTRY only, on `feat/svelte-1.3`. The
`client/js/` paths above are shared ground under an owner ruling, not ours
to re-seat alone. Adding an action there is fine and expected until the
Svelte surface can render it.

**`feat/svelte-1.3` is fetchable from `adamdev` and `origin` at `d6801cb`.**
It was on neither remote before today. Paths worth reading first, in this
order:

- `web/src/lib/plugins/types.ts` - the plugin contract. This is the shape
  we would rather not have rewritten this week.
- `web/src/lib/plugins/registry.ts` - registration and lookup, with
  `registry.test.ts` beside it.
- `web/src/lib/plugins/session-card-actions.ts` - the surface the row menu
  renders from.
- `web/src/lib/plugins/mark-unread/index.ts` - the first and so far only
  real contribution, gated on `ui.show_mark_unread_control`.
- `web/src/lib/mount.ts` - the single seam legacy JS mounts through.
- `web/src/lib/led.ts`, `web/src/lib/StatusLed.svelte` - the LED port, on
  release/1.2's ring model after `58e552e`.
- `.claude/notes/svelte-migration-launchpad.md` - the seven slice plan.

Mute is the natural second plugin and the server contract in `46e7aca` is
what it should call, unchanged.
