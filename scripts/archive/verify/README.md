# Archived one-off verify scripts

Each script here was a real-browser or real-server pixel/behaviour proof
written to nail down one specific, now-shipped bugfix. They are kept rather
than deleted per the project's script policy. None of these are wired into
CI or into any runbook; the regression coverage they proved now lives in a
permanent automated test under `tests/`.

Do not restore one of these as an active tool without first checking whether
its sibling `lib_*.py` helper in `scripts/` (several were extracted
specifically to back one of these files: `lib_adopt_clear_server.py`,
`lib_theme_carrier_checks.py`, `lib_sidebar_edge_checks.py`) still matches
the shipped code, and whether its own cross-imports of other archived or
kept scripts still resolve from this new location. They are not maintained
here and are not expected to still run.

| Script | What it verified | Closed by | Covered by |
|---|---|---|---|
| `verify_adopt_clears_prompt.py` | "adopt all" leaving the attribution prompt card still painted (stale snapshot, not the live rows) | Stage C follow-up, 2026-08-24 (`docs/session-attribution-import.md`) | `tests/test_attribution_prompt_reflects_live_state.py` |
| `verify_attribution_prompt.py` | Stage C attribution prompt pixels: layout, positive control, unstyled buttons, zero-pixel card, injected glyph in a rendered name | `f87c01ec` | `tests/test_session_attribution_prompt_api.py`, `tests/test_home_screen_mechanics.node.mjs` |
| `verify_dead_row_restart.py` | a dead session row offering restart, not only delete | `b66b3382` | `tests/test_dead_row_renders_dead.node.mjs`, `tests/test_restart_*` family |
| `verify_ended_session_marking.py` | the ended-session row rendered correctly in both themes | `dc27c7f5` | `tests/test_ended_sessions_visibility.node.mjs` |
| `verify_family_pill_tilde.py` | tilde count on a guessed agent-family pill | `dc1d13a4` | `tests/test_agent_family_pill.node.mjs`, `tests/test_agent_family_display.py` |
| `verify_folder_picker.py` | the folder picker modal still worked after being extracted from launchpad.js | `d2b6cee4` | `tests/test_folder_picker_modal.node.mjs` |
| `verify_fresh_install.py` | a genuinely empty install has a usable first screen | `b658cddc` | `tests/test_fresh_install.py` |
| `verify_login_chrome.py` | the login screen's chrome (kebab icon, header menu) actually gone, in pixels | `dce1cdca` | `tests/test_login_chrome.node.mjs`, `tests/test_login_chrome_control_can_fail.py`, `tests/test_csp_no_inline_handlers.node.mjs` |
| `verify_login_theme.py` | the login screen renders in the user's theme, not Claude's | `d0d14653` | `tests/test_login_theme_precache.node.mjs` |
| `verify_logout_chrome.py` | clicking logout actually logs the user out (CSP forbids inline handlers) | `63235d97` | `tests/test_logout_confirms_once.node.mjs`, `tests/test_csp_no_inline_handlers.node.mjs` |
| `verify_missing_project_click.py` | clicking a project whose folder is gone says so instead of doing nothing | `969ab568` | `tests/test_project_presence.py` |
| `verify_session_name_surfaces.py` | the tab title and a toast card call a session by the name its owner gave it | `78d8e872` | `tests/test_session_label_resolver.node.mjs` |
| `verify_session_ownership_badge.py` | the tmux/external ownership badge, adopt-then-owned in both directions | `afab898f` | `tests/test_session_ownership_origin.py` |
| `verify_session_stripe.py` | the session-type left-edge stripe removed, row border themed instead | `7c2ff983` | `tests/test_theme_token_sourcing.py` |
| `verify_session_theme_carrier.py` | the row border means selection only, and theme identity moved off it | `e5c15c6e` | `tests/test_session_theme_tint.node.mjs` |
| `verify_settings_gui.py` | the workspace settings tab actually renders and is reachable, in pixels | `e5a05090` | `tests/test_settings_workspace.node.mjs` |
| `verify_sidebar_row_edges.py` | the thick left colour bar removed from every sidebar row | `6f782880` | `tests/test_session_theme_tint.node.mjs`, `tests/test_sidebar_sessions.node.mjs` |
| `verify_status_dot_shape.py` | `unknown` renders as a different shape from every definite status | `ade0def3` | `tests/test_status_led.node.mjs` |
| `verify_toast_dismiss.py` | toasts leave on user action, stay otherwise, scoped correctly | `a945771` | `tests/test_toast_dismiss.node.mjs` |
| `verify_toast_stacking.py` | a burst of toasts stays legible, the cap/overflow row is a real measured box | `649ddb92` | `tests/test_toast_stacking.node.mjs` |
| `verify_status_led_geometry.py` | that every (inner, outer) LED pair paints one lit diameter, measured in a real Chromium under the app's CSP | the 1.2 merge, 2026-09-09 | `tests/test_status_led.node.mjs` |
| `verify-adopt-resize.py` | an adopted tmux session resizes like any other | `ea98931b` | `tests/test_adopt_resize.py` |

## Kept in place, not archived

These matched the `verify_*` naming pattern but were not moved, for the
reasons below. They still live in `scripts/`.

- `verify_header_icons_and_menu.py` - actively invoked (`VERIFIER=`) by
  `scripts/ci/mutate-header-icons-and-menu.sh`.
- `verify_sidebar_groups.py` - actively invoked by
  `scripts/ci/mutate-sidebar-groups.sh`.
- `verify_sidebar_sessions.py` - actively invoked by
  `scripts/ci/mutate-sidebar-sessions.sh`,
  `scripts/ci/mutate-density-menu-placement.sh`, and
  `scripts/ci/mutate-sidebar-groups.sh`.
- `verify_sidebar_rename.py` - imported by `verify_sidebar_groups.py`
  (`from verify_sidebar_rename import measure_inline_rename`), which is
  itself called by CI mutation testing above. A load-bearing dependency of
  an active tool, not a standalone one-off.
- `verify_lifecycle_reconcile.py` - a parameterised operator tool
  (`--db`, `--listing`), not a proof of one closed bug. Runs the lifecycle
  reaper against an arbitrary real `cloude.db` copy.
- `verify_selection_apps.py`, `verify_selection_regressions.py`,
  `verify_selection_scrolled.py` - a parameterised trio (argparse, live
  server plus TOTP) that cross-import each other
  (`verify_selection_scrolled` is the base module the other two import
  from); general terminal-selection regression coverage, not tied to one
  bug, and still listed as reusable release-time harnesses in
  `RELEASE-NOTES.md`.
- `verify_home_mechanics.py` - a multi-item regression harness (items
  numbered at least into the 50s), not a single closed bug. Referenced by
  a comment in `scripts/ci/mutate-home-screen-mechanics.sh` as covering
  ITEM 53, and `RELEASE-NOTES.md` shows individual items (ITEM 48) still
  open across multiple past releases. Unsure whether every item it
  measures has a permanent-test equivalent; kept rather than guessed at.
- `verify_sidebar_group_drag.py` - companion to the actively-called
  `verify_sidebar_groups.py` (imports from `verify_sidebar_sessions.py`
  itself), last touched 2026-09-07, in a sidebar-groups area of the
  codebase under active edit as of this archiving pass. Kept rather than
  archived mid-development.

- `verify_status_led_geometry.py` - arrived from the other line of
  development at the 1.2 merge and was archived on the way in rather than
  landing top-level, per the convention this directory records. IT WAS
  WRITTEN AGAINST A CONSTRUCTION THAT DID NOT SHIP: it measures the
  `::after` halo plus `--led-lit-scale` composition, and the LED that
  shipped draws both rings as layers of ONE box-shadow with no
  pseudo-element at all. Re-read it before trusting a run. The rule it was
  proving - one lit diameter for every state - did ship, and is asserted
  statically in `tests/test_status_led.node.mjs`.

## Five manual harnesses retired with these drivers, 2026-09-12

`tests/manual/*.html` harnesses are the pages the scripts above drive. Three
of the ones listed in the table had already lost their driver to this
directory and were left behind in `tests/manual/`; two more were driven by
nothing at all. Slice 7 of the Svelte migration then deleted
`client/js/launchpad.js`, and every one of them opened with
`<script src="../../client/js/launchpad.js">` and booted with
`new Launchpad()`, which no longer exists. They were removed rather than
rewritten, and the reason is different for each group.

| Harness | Its driver | Why it was retired rather than rewritten |
|---|---|---|
| `attribution-adopt-harness.html` | `verify_adopt_clears_prompt.py` (archived) | The driver was archived here as a closed one-off; the harness merely outlived it. Retiring it finishes a decision this directory already records. |
| `attribution-prompt-harness.html` | `verify_attribution_prompt.py` (archived) | Same. Note the table above says it is covered by `tests/test_home_screen_mechanics.node.mjs`, which slice 7 also deleted; the card itself is now `web/src/lib/launchpad/AttributionPrompt.svelte`. |
| `ended-sessions-harness.html` | `verify_ended_session_marking.py` (archived) | Same. The row is `web/src/lib/launchpad/EndedSessionRow.svelte` now. |
| `project-tree-geometry-harness.html` | none, ever | Nothing drove it. The three sibling harnesses that name it only say "same pattern as" in a comment. |
| `project-authority-geometry-harness.html` | none, ever | Nothing drove it. |

**A HARNESS NOBODY DRIVES CANNOT BE VERIFIED, WHICH IS THE WHOLE ARGUMENT.**
Rewriting one of these onto `CloudeWeb.launchpad.mountHomeScreen()` is easy
and is exactly what was done for the two that a live script still drives
(`home-mechanics-geometry-harness.html` and
`header-icons-and-menu-harness.html`, both rewritten and both RUN). For
these five there is no consumer, so there would have been no way to tell a
correct rewrite from one that loads and proves nothing - and a page that
loads and proves nothing is worse than no page, because it looks like
coverage. That is this project's most expensive recurring defect and it is
not worth re-creating five times over.

The files were moved to `~/.Trash/`, not deleted, and their full content is
in git history at `18ed433`. If one of these surfaces needs a pixel proof
again, restore it from there and rewrite the bootstrap the way the two
surviving harnesses now do - **and write the driver in the same change.**
