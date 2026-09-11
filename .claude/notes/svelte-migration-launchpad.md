# Svelte 5 migration, screen 1: the launchpad

Measured on branch v1.1, 2026-09-09. `client/js/launchpad.js` is 6,480 lines,
one `class Launchpad` with 113 methods, exported as the `window.Launchpad`
singleton. Every line number here was re-derived today, not quoted.

**Correction to HANDOFF section 3 before anything else.** That section says
`renderProjectList()` has "no signature guard and no pause on tab hide". That is
stale. `client/js/project-list-render-guard.js` (217 lines, commit ee5d547) now
wraps it: `renderProjectList()` (:4507) builds through the pure
`_projectListHtml()` (:4536) and paints only on a `paint` verdict, and
`_startRunningSessionsPoller()` (:527) consults `ProjectListRenderGuard.shouldPoll`
which stops the tick when `#launchpad-screen` has lost `.active`.
`tests/test_project_list_render_guard.node.mjs` measures 0 rebuilds and 0 listener
registrations on unchanged data, and 0/0/0 while hidden. The residual defect is
different and smaller, and it is stated in slice 4 below. Do not sell this
migration on a bug that is already fixed.

## 1. Inventory

**Every method in launchpad.js, grouped by what it actually does.**

(a) Pure render, string building only, no DOM write and no fetch. About 924 lines.

| lines | method | n |
|---|---|---|
| 882-894 | `_renderProjectAuthorityBannerHtml` | 13 |
| 1246-1275 | `_workRecencyAttrs` | 30 |
| 1508-1530 | `_listingReasonFromError` | 23 |
| 1531-1556 | `_listingDetailFromError` | 26 |
| 1557-1587 | `_renderListingAttentionHtml` | 31 |
| 1634-1639 | `_renderSessionIdHtml` | 6 |
| 1873-1950 | `_renderRecentSessionRowHtml` | 78 |
| 2209-2261 | `_restartPlan` | 53 |
| 2262-2317 | `_restartNotice` | 56 |
| 2421-2488 | `_renderRenamePencilHtml` | 68 |
| 2489-2512 | `_renderFamilyPillHtml` | 24 |
| 2513-2542 | `_deriveRunningSessionDisplayName` | 30 |
| 2543-2573 | `_sessionDisplayLabel` | 31 |
| 2589-2601 | `_escapeHtml` | 13 |
| 2602-2627 | `_formatRelativeTime` | 26 |
| 4167-4176 | `_projectWorkAttrs` | 10 |
| 4177-4181 | `_renderTreeSessionRowsHtml` | 5 |
| 4182-4228 | `_renderTreeSessionRowHtml` | 47 |
| 4229-4263 | `_renderEndedTreeSessionRowHtml` | 35 |
| 4264-4294 | `_renderNoProjectGroupHtml` | 31 |
| 4295-4327 | `_renderProjectAttentionGroupHtml` | 33 |
| 4471-4506 | `_renderArchivedNoticeHtml` | 36 |
| 4536-4716 | `_projectListHtml` | 181 |
| 6379-6416 | `_explainRefusedProject` | 38 |

(b) Data fetch, poll and state. About 1,430 lines.

| lines | method | n |
|---|---|---|
| 8-185 | `constructor` (the whole state model) | 178 |
| 186-263 | 4 visibility-pref get/set (localStorage) | 78 |
| 527-549 | `_startRunningSessionsPoller` (the 5s tick) | 23 |
| 550-565 | `_getTerminalDims` | 16 |
| 566-627 | `loadProjects` | 62 |
| 628-648 | `loadAttributionPrompt` | 21 |
| 847-881 | `loadProjectAuthority` | 35 |
| 895-930 | `loadProjectPresence` | 36 |
| 931-1204 | `loadRunningSessions` (the two-endpoint merge) | 274 |
| 1205-1245 | `_sortRunningSessionsByWork`, `_workStampFor` | 41 |
| 1276-1340 | `loadSessionAttribution` | 65 |
| 1341-1411 | `_buildWorkStampIndex` | 71 |
| 1412-1482 | `_resolveSessionAttribution` | 71 |
| 1483-1507 | `_noteListingUnknown` | 25 |
| 1835-1872 | `loadRecentSessions` | 38 |
| 2574-2588 | `_getActiveSessionName` | 15 |
| 3850-3899 | collapsed-section state (localStorage) | 50 |
| 3900-4054 | `_buildProjectSessionGroups` (the join) | 155 |
| 4055-4166 | `_endedSessionsForTree` | 112 |
| 5980-6043 | `_findRunningSessionBySlug` | 64 |

(c) DOM write and event wiring. About 2,101 lines. This is the group Svelte
deletes outright.

| lines | method | n |
|---|---|---|
| 264-294 | `init` | 31 |
| 295-526 | `setupNewFab`, `bindHeaderHelpToggle`, `toggleNewFab`, `placeNewFabMenu`, `openNewFab`, `closeNewFab` | 232 |
| 649-785 | `renderAttributionPrompt`, `_bindAttributionPrompt` | 137 |
| 1588-1633 | `_updateRunningSessionsCount` | 46 |
| 1640-1834 | `renderRunningSessions` | 195 |
| 1951-2105 | `renderRecentSessions`, `_bindRecentSessionClicks` | 155 |
| 2351-2420 | `_updateRunningSessionAges` | 70 |
| 2720-2838 | `_bindRunningSessionClicks` | 119 |
| 2910-3069 | `_handleRenameRunningSession` | 160 |
| 3291-3653 | `renderLaunchpadUI` (the whole screen shell) | 363 |
| 3654-3705 | `renderHomeBarVersion`, `wireServerControls` | 52 |
| 3706-3849 | 4 section-disclosure and toggle wirers | 144 |
| 4328-4470 | `_bindProjectNodeToggles`, `_applyProjectNodeCollapsed`, `_bindProjectSessionRowClicks` | 143 |
| 4507-4535 | `renderProjectList` | 29 |
| 4717-4800 | `_bindProjectListHandlers` | 84 |
| 6349-6378 | `updateStatus` | 30 |
| 6417-6478 | `showError` | 61 |

(d) Navigation and router glue. About 441 lines.
`_returnToActiveRunningSession` (2628-2719, 92), `_handleAttachRunningSession`
(3212-3290, 79), `connectToExistingSession` (5901-5923, 23), `detachAndCreateNew`
(5924-5979, 56), `openProjectByName` (6044-6119, 76), `selectProject`
(6234-6329, 96), `detachAndOpenProject` (6330-6348, 19).

(e) Modals and flows. About 1,559 lines.
Attribution answers: `_adoptAttributed` (786-807), `_declineAttributed`
(808-846). Recent-row actions: `_forkSession` (2106-2142), `_deleteSessionRecord`
(2143-2208), `_restartRecentSession` (2318-2350). Running-row actions:
`_handleMarkUnread` (2839-2909), `_handleRestartSession` (3070-3127),
`_handleSessionRowAction` (3128-3211). Archive: `archiveProject` (4801-4831),
`unarchiveProject` (4832-4847). Edit: `editProject` (4848-4891),
`showEditProjectModal` (4892-5039, 148). Generic: `showConfirmModal` (5040-5066),
`_showChoiceModal` (5067-5177, 111). Create: `startNewClaudeProject` (5178-5208),
`startSessionInExistingProject` (5209-5261), `createNewSession` (5262-5270),
`createNewSessionWithAgent` (5271-5292), `createConsoleSession` (5293-5361),
`_createNewSessionInner` (5362-5534, 173), `showProjectNameModal` (5535-5689, 155).
Clone: `showCloneFromGithubModal` (5690-5900, 211). Folder step:
`saveProjectWithUniqueName` (6186-6218), `showFolderPickerModal` (6219-6233,
a 15-line delegate to `FolderPickerModal.open`).

**Module-level state, and who reads it.** All of it is instance fields on the
singleton, set in the constructor at 8-185 unless noted.

| field | read by |
|---|---|
| `launchpadScreen` | `init`, and `app.js:963` as the "already inited" test |
| `projects` | `_projectListHtml`, `_buildProjectSessionGroups`, `openProjectByName`, `_findRunningSessionBySlug` |
| `_lastProjectListSig` | `renderProjectList` only |
| `projectAuthority` | `_renderProjectAuthorityBannerHtml` |
| `attributionPrompt`, `attributionPromptClosed` | `renderAttributionPrompt` |
| `projectPresence` (Map by raw config path) | `_projectListHtml`, `_explainRefusedProject`, `selectProject` |
| `runningSessions` | `renderRunningSessions`, `_buildProjectSessionGroups`, `_updateRunningSessionAges`, `_endedSessionsForTree`, every row handler |
| `_resolvingDeepLink` | `selectProject`'s refusal guard, set by `openProjectByName` |
| `sessionAttribution` (name-only Map) | `_buildProjectSessionGroups` fallback rung |
| `sessionAttributionByInstance` (`name\u0000epoch`) | `_buildProjectSessionGroups` exact rung, `_deleteSessionRecord` |
| `sessionAttributionAmbiguous` (Set) | `_buildProjectSessionGroups` |
| `sessionAttributionListingOk` / `...Detail` | `_buildProjectSessionGroups`, `_endedSessionsForTree` |
| `sessionRecords` | `_endedSessionsForTree`, and `session-sidebar-clicks.js:326` from outside |
| `_workStampByName` | `_workStampFor`, `_sortRunningSessionsByWork`, `_projectWorkAttrs` |
| `_collapsedProjectNodes` (Set) | `_projectListHtml`, `_bindProjectNodeToggles` |
| `projectsListingOk`, `_archivedFetchOk` | `_renderArchivedNoticeHtml` |
| `_archivedVisible`, `_deletedSessionsVisible` | `loadProjects`, `loadRecentSessions`, the two toggles |
| `runningSessionsListing` (set at :934, not the ctor) | `_renderListingAttentionHtml`, `_updateRunningSessionsCount` |
| `_lastRunningSig` (set at :1666) | `renderRunningSessions` |
| `recentSessions`, `recentSessionsState`, `recentSessionsNotice` (set at :1844) | `renderRecentSessions` |
| `_runningPollInterval` | the poller's idempotence guard. There is still no `clearInterval` in the file |

## 2. The state model the Svelte version needs

**One runes store owns the four fetches, the join and the tick; the sidebar
folds the same data today with its own copy, so writing it once is deduplication,
not speculation.** `client/js/session-sidebar-fetch.js:60/71/105` calls the same
`listAttachableSessions` / `listSessions` / `listSessionRecords` trio and rebuilds
the same work-stamp index.

Endpoints and the exact field levels:

- `GET /sessions/attachable` -> `AttachableSession[]` (`src/models.py:850`). Flat.
  `name`, `label`, `created_by_cloude`, `created_at_epoch`, `window_count`,
  `agent_type`, `agent_family`, `agent_family_source`, `agent_wrapper_label`,
  `pinned_theme`, `session_row_id`, `parent_session_id`, `status`, `unread`,
  `listing_ok`, `listing_reason`. Note the field is `status`, not
  `activity_status`, and there is **no** `startup_gate` here.
- `GET /sessions/list` -> `SessionInfo[]` (`src/models.py:232`). Two levels.
  Wrapper: `activity_status`, `unread`, `startup_gate`, `status_source`,
  `tmux_session`, `agent_type`, `agent_family`, `agent_family_source`,
  `agent_wrapper_label`, `pinned_theme`, `session_backend`, `session_row_id`,
  `parent_session_id`, `label`, `created_by_cloude`, `recent_logs`,
  `local_servers`, `stats`. Nested `.session` (`Session`, :138): `id`,
  `pty_pid`, `working_dir`, `status`, `created_at`, `last_activity`,
  `agent_type`, `pinned_theme`, `tmux_session`, `model`.
  **`SessionInfo` carries no `created_at_epoch`.** Only `AttachableSession` does.
- `GET /sessions/records` -> `SessionRecord[]` (:2094). `session_uuid`, `id`,
  `tmux_name`, `tmux_created_epoch`, `lifecycle`, `project_id`,
  `project_attribution`, `working_dir`, `archived_at`, `title`,
  `parent_session_id`, `last_work_at`, `owned`, `agent_type`, `agent_family`,
  `agent_family_source`.
- `GET /sessions/recent[?include_archived=true]` -> `RecentSessionsResponse`
  (:2343): `state` in `ok` / `probe_unavailable` / `never_probed`, `sessions`,
  `notice`. `state !== 'ok'` must render the notice, never an empty list.
- `GET /projects?include_archived=`, `GET /projects/presence`,
  `GET /projects/authority`, `GET /sessions/attribution-prompt`.
- **Groups endpoints are not on this screen.** `listSessionGroups` and friends
  are called only from `session-sidebar-group-actions.js:96`. The launchpad's
  "groups" are the project tree groups, computed client-side.

The join, and the trap in it. `_buildProjectSessionGroups` keys
`sessionAttributionByInstance` on `${tmux_name}\u0000${created_at_epoch}` and
falls back to a name-only map. Because `/sessions/attachable` filters out
currently-live sessions and `SessionInfo` has no epoch, a live-only row is
unshifted at :1078 with `created_at_epoch: live.created_at_epoch || 0` and so
always takes the name-only rung. Preserve both rungs and both failure verdicts
(`ambiguous` and `listingOk === false` route to NEEDS ATTENTION, they never
render as "no project").

Proposed module: `web/src/lib/sessions/store.svelte.ts`, one file.

```
$state:  attachable, live, records, recentPayload, projects, presence,
         authority, attributionPrompt, listing {ok, reason, detail, sources}
$derived: rows          // the merged running-session rows, dead filtered
          workStamps    // tmux_name -> newest last_work_at
          endedRows     // _endedSessionsForTree, ported
          groups        // {byProjectId, noProject, needsAttention}
methods: refreshAll(), start(), stop()
```

`start()` owns the single 5s `setInterval` and **registers a `clearInterval` on
teardown**, which today does not exist anywhere in launchpad.js. Types keep
`SessionListItem { session: SessionCore; activity_status; unread; ... }` nested
and never flatten it: `info.id` then becomes a compile error, which is the first
time this repo's most-repeated bug is catchable before runtime.

UI-only state (`showArchived`, `showDeleted`, collapsed sections, collapsed
project nodes) goes in `web/src/lib/ui/prefs.svelte.ts` with the same
localStorage keys, byte for byte, so an existing user's screen looks unchanged
on first load.

## 3. Slice plan

**Seven slices, smallest first, each one deletes its legacy code in the same
commit.** `#launchpad-screen` is an empty `<div>` in `client/index.html`;
everything inside it is written by `renderLaunchpadUI()` at runtime. So every
slice mounts into a container legacy itself created, and no slice needs to touch
`client/index.html`, `src/main.py` or `scripts/`. The single dependency on the
toolchain worker is that `client/dist/app.js` and `app.css` are loaded once.

The mount helper, written in slice 1 and used by all seven:
`mountPanel(id, Component, props)` in `web/src/main.ts`, which records the
`mount()` handle per id and `unmount()`s an existing one first. Legacy calls it
by name at the exact point its own render used to run. That is one line per
slice inside launchpad.js, and it is deliberately a direct call rather than an
event bus.

Styling rule for slices 1 to 6: components reuse the existing class names and
the existing stylesheets in `client/css/`. Tailwind is used for layout utilities
only. No colour literal ever, only `var(--color-*)`. This keeps all 26 themes
working with zero theme work and keeps each slice small.

**Slice 1, the attribution prompt card. About 219 legacy lines.**
Moves: `loadAttributionPrompt` (21), `renderAttributionPrompt` (90),
`_bindAttributionPrompt` (47), `_adoptAttributed` (22), `_declineAttributed` (39),
plus the two constructor fields. Deleted same commit: all five methods and the
`renderAttributionPrompt()` call in `loadProjects`. Mounts into the existing
`<div id="attribution-prompt">` (:3455), which is never re-written after init.
Tests: no dedicated node test exists; write the Vitest one this slice
(unavailable-state renders the notice, adopt and decline post the right names,
a silent close does not persist).
Browser check: with an unattributed external tmux session up, the card appears,
adopt moves it into the tree, decline leaves it external.
Risk: low. This slice exists to prove the build, the CSP and the mount helper.

**Slice 2, the recent sessions section. About 604 legacy lines plus
`session-recent-visibility.js` (148).**
Moves: `loadRecentSessions`, `_renderRecentSessionRowHtml`,
`renderRecentSessions`, `_bindRecentSessionClicks`, `_forkSession`,
`_deleteSessionRecord`, `_restartPlan`, `_restartNotice`, `_restartRecentSession`,
`initDeletedSessionsToggle`, `_applyDeletedSessionsToggleState`, the two
deleted-visible prefs. Creates `store.svelte.ts` holding the recent slice only.
Mounts into `#recent-sessions-list` and takes over `#recent-sessions-count` and
`#recent-show-deleted-toggle` as part of the same component.
Tests to port: `test_recent_sessions`, `test_recent_deleted_sessions`,
`test_recent_deleted_visibility`, `test_recent_section_collapse`,
`test_no_delete_wording`, `test_row_action_confirm_names_label`.
Browser check: the recent list, the show-archived checkbox, restart, fork and
delete-record all behave, and `state !== 'ok'` still prints the notice.
Risk: medium. `_deleteSessionRecord` is a soft archive and must not be confused
with `destroySession`; keep the wording tests.

**Slice 3, the store. About 820 legacy lines, no visual change.**
Moves: `loadProjects`, `loadProjectAuthority`, `loadProjectPresence`,
`loadRunningSessions`, `loadSessionAttribution`, `_buildWorkStampIndex`,
`_resolveSessionAttribution`, `_noteListingUnknown`, `_listingReasonFromError`,
`_listingDetailFromError`, `_sortRunningSessionsByWork`, `_workStampFor`,
`_startRunningSessionsPoller`. The surviving legacy renderers stop reading
`this.*` and read the store instead, so there is exactly one data path.
Tests to port: `test_session_attribution_join`, `test_session_work_ordering`,
`test_session_lists_are_disjoint`, `test_dead_pane_not_running`,
`test_running_sessions_unknown`, `test_ended_sessions_visibility`,
`test_no_name_keyed_session_row_lookup`.
Browser check: nothing looks different, and the network tab still shows the same
four requests every 5s while home is up and none while the terminal is up.
Risk: high, and this is the slice to review hardest. `loadRunningSessions` is
274 lines of unconditional-overwrite rules (`agent_family`, `agent_wrapper_label`,
`startup_gate`, `status_source`, `label` each documented as never `||`-defaulted),
plus the dead-pane filter and the three-outcome listing latch. Port it line by
line; do not rewrite it while moving it.

**Slice 4, the project tree. About 900 legacy lines plus
`project-list-render-guard.js` (217).**
Moves: `_projectListHtml`, `renderProjectList`, `_bindProjectListHandlers`,
`_buildProjectSessionGroups`, `_endedSessionsForTree`, the five tree-row
renderers (4167-4327), `_bindProjectNodeToggles`, `_applyProjectNodeCollapsed`,
`_bindProjectSessionRowClicks`, `_renderArchivedNoticeHtml`,
`_renderProjectAuthorityBannerHtml`, `_projectWorkAttrs`, `_workRecencyAttrs`,
`initArchivedVisibleToggle`, `_applyArchivedVisibleToggleState`, the archived
prefs, the collapsed-node state. Deleted same commit: the guard module and its
two call sites, `_lastProjectListSig`.
Tests to port: `test_project_session_tree`, `test_project_archive_render`,
`test_project_presence_render`, `test_project_authority_render`,
`test_project_authority_banner`, `test_project_gutter_alignment`,
`test_ended_sessions_visibility`, and `test_project_list_render_guard` rewritten
as the mutation test below.

The perf claim, stated honestly. The guard already gets unchanged ticks to zero
mutations. What it cannot do is make a CHANGED tick cheap: one flipped status dot
today still reparses ~794 nodes and rebinds ~45 listeners, and when a row menu is
open or a rename input is focused the guard has to skip the paint entirely, so
correctness is bought with staleness. Reactive rendering removes both.

How to prove it, and it is a count, not a signature. In a real browser on the
owner's box, attach a `MutationObserver(document.getElementById('project-list'),
{childList:true, subtree:true, attributes:true, characterData:true})`, hold it
across 12 poller ticks (60s) during which exactly one session changes status,
and record `records.length`. Legacy baseline: one whole-subtree replacement, so
roughly 800 added plus 800 removed nodes. Target after: under 5 records for that
one dot. Run the same 60s window with nothing changing and assert 0 in both
builds. Also assert the busy case: open a row overflow menu, let a status change
land, and confirm the dot updates while the menu stays open, which the guard
build cannot do.

Browser check: the tree, the collapse chevrons, presence badges, the archived
notice, the authority banner, and clicking a session row to open it.
Risk: medium-high. `_buildProjectSessionGroups` has five distinct
NEEDS ATTENTION reasons and a `deleted wins over live` rule; a lost branch here
renders a false green.

**Slice 5, the running sessions list. About 1,100 legacy lines.**
Moves: `renderRunningSessions`, `_updateRunningSessionsCount`,
`_renderListingAttentionHtml`, `_renderSessionIdHtml`, `_renderRenamePencilHtml`,
`_renderFamilyPillHtml`, `_deriveRunningSessionDisplayName`,
`_sessionDisplayLabel`, `_formatRelativeTime`, `_updateRunningSessionAges`,
`_bindRunningSessionClicks`, `_handleMarkUnread`, `_handleRenameRunningSession`,
`_handleRestartSession`, `_handleSessionRowAction`. Deleted same commit:
`_lastRunningSig`. `app.js:1405` calls `_deriveRunningSessionDisplayName`, so
that one function is re-exported on the shim until slice 7.
Tests to port: `test_running_sessions_unknown`, `test_agent_family_pill`,
`test_launchpad_wrapper_pill`, `test_launchpad_rename_edits_label`,
`test_session_label_rendering`, `test_session_ownership_badge`,
`test_session_theme_tint`, `test_session_startup_gate`, `test_unread_led_one_field`,
`test_status_light_placement`, `test_session_row_actions`, `test_session_row_restart`.
Browser check: rename inline, mark unread, restart, close, and the age strings
ticking without a full repaint.
Risk: medium. `_handleRenameRunningSession` is 160 lines of focus and escape
handling; port the test first.

**Slice 6, modals and flows. About 1,560 legacy lines plus
`project-create-folder.js` (312).**
Moves: create (`startNewClaudeProject`, `startSessionInExistingProject`,
`createNewSession`, `createNewSessionWithAgent`, `createConsoleSession`,
`_createNewSessionInner`, `showProjectNameModal`), clone
(`showCloneFromGithubModal`), folder step (`saveProjectWithUniqueName`,
`showFolderPickerModal`, and `ProjectCreateFolder`), project edit and archive
(`editProject`, `showEditProjectModal`, `archiveProject`, `unarchiveProject`),
and the two generic modals (`showConfirmModal`, `_showChoiceModal`).
`providers.js:476` calls `showConfirmModal` and `:83` calls `_escapeHtml`, so
both stay on the shim until slice 7.
Tests to port: `test_project_create_folder`, `test_folder_picker_modal`,
`test_folder_picker_path_overflow`, `test_launchpad_create_label`,
`test_newfab_placement` (partly), `test_provider_groups`.
Browser check: create a project from a new folder, clone a repo, rename and
archive a project, and confirm every modal still stacks under
`client/css/modal-stack.css`.
Risk: medium. `_createNewSessionInner` is 173 lines with the wrapper and
provider picker inside it.

**Slice 7, the shell, and the end of launchpad.js. About 900 legacy lines.**
Moves: `renderLaunchpadUI`, `init`, the six FAB methods, `bindHeaderHelpToggle`,
`initSectionDisclosures`, `setSectionExpanded`, the collapsed-section state,
`renderHomeBarVersion`, `wireServerControls`, `updateStatus`, `showError`, and
the nav glue (`openProjectByName`, `selectProject`, `detachAndOpenProject`,
`connectToExistingSession`, `detachAndCreateNew`, `_handleAttachRunningSession`,
`_returnToActiveRunningSession`, `_findRunningSessionBySlug`).
`client/js/launchpad.js` is deleted. `window.Launchpad` becomes a thin typed shim
exported from the bundle carrying exactly the seven members outside code uses:
`init`, `launchpadScreen`, `loadProjects`, `loadRunningSessions`,
`openProjectByName`, `createConsoleSession`, `_handleAttachRunningSession`,
`_deriveRunningSessionDisplayName`, `sessionRecords`, `showConfirmModal`,
`_escapeHtml`, `showProviderModal`.
Tests to port: `test_home_screen_mechanics`, `test_home_screen_polish`,
`test_home_bottom_bar`, `test_home_header_consolidation`,
`test_header_help_and_toggle`, `test_launchpad_help_content`,
`test_newfab_placement`, `test_deeplink_resolver`, `test_deeplink_fork_name`,
`test_server_status_panel`, `test_archive_entry_points`.
Browser check: hard reload on `/`, then a deep link to `/p/<name>` and to a
session, then back home; the theme must follow every hop.
Risk: high, because it is the slice that removes the last legacy fallback.

62 node tests under `tests/*.node.mjs` load one or more of the launchpad module
family; 19 of them read `client/js/launchpad.js` itself. Those 62 are the spec.
A slice may only delete a test file when its assertions exist in Vitest.

## 4. Cross-cutting concerns every slice must respect

**Five contracts that outlive launchpad.js.**

- **Router deep links.** `router.js:352` calls
  `window.Launchpad.openProjectByName(target)` and `openProjectByName` calls
  `Router.rejectTarget(name)` on a miss (two call sites). Both directions must
  survive every slice, and `_resolvingDeepLink` must keep gating `selectProject`
  so deep-link resolution can never create a session. Keep the guard as an
  explicit store flag, not an implicit call order.
- **Theme navigation.** `ThemeNavigation.applyForTarget` is total: every
  navigation ends in an `applyTheme` call. Svelte components must never call
  `Themes.applyTheme` directly and must never paint a theme on mount. A row's
  `pinned_theme` is read off the `/sessions/list` **wrapper**, not `.session`.
- **Themes are already extensible and the components must not break that.**
  26 manifests at `client/css/themes/<id>/theme.json`, plus a user directory,
  supply `cssVars` onto `:root` via `client/js/themes/registry.js`. Every
  component colour goes through an existing custom property (104 in
  `styles.css`, 43 in `status-led.css`). No hex literal, no Tailwind palette
  colour, no `color-mix()` against a literal. If a component needs a token that
  does not exist, add it to a NEW css file, not to `styles.css`.
- **The LED contract.** `SessionStatusUI.dotHtml(status, signals)` where signals
  is `{unread, startup_gate, status_source, size}`, which delegates to
  `StatusLed.ledStateFor`. Four launchpad call sites (:1746, :1899, :4189, :4235).
  Svelte renders a `<StatusDot>` component that calls `ledStateFor` and emits the
  same `status-dot status-dot--<state> status-led` classes. Do not inline LED
  markup in a template, and do not fork the two-vocabulary class rule.
- **Escaping.** There are 13 hand-rolled escape helpers across `client/js` plus
  one delegate. Svelte's `{expr}` interpolation makes six of them dead:
  `launchpad.js:_escapeHtml` (:2589), the three local copies at :4897, :5548 and
  :5705, the one injected at :6221, and `project-create-folder.js:51`. They die
  in slices 6 and 7. `providers.js:83` delegates to `Launchpad._escapeHtml` and
  must get its own before slice 7 removes it. Seven survive because they belong
  to other screens: `settings-sections.js:25`, `settings-tabs.js:33`,
  `agent-wrappers-view.js:36`, `slash-commands.js:410`, `slash-favorites.js:70`,
  `session-detail.js:99`, `terminal-commands-panel.js:39`. One caveat: Svelte
  escapes text, not attribute construction inside `{@html}`. There is no
  `{@html}` in this plan; if a slice reaches for one, that is the review trigger.
- **What app.js reaches into.** Only four ids, and they are load-bearing.
  `app.js:896` toggles `.active` on `#launchpad-screen` (leave that element and
  that class alone). `app.js:358` re-parents `#statusText` into
  `#home-bar-status`. `app.js:381` writes `#home-bar-status-text`.
  `globalAudioToggle.js:300` re-parents into `#home-bar-status` too. Slice 7 must
  keep those four ids present in the Svelte home bar and expose them as
  `<slot>`-style anchors rather than letting the migration silently move them.

## 5. What this screen's rounds do not touch

**Four things stay vanilla, and each has a measured reason.**

- **The terminal** (`terminal.js` 2,422 lines and 14 satellite modules). xterm.js
  plus a per-session WebSocket, imperative by nature, no shared state with the
  launchpad other than `Launchpad.loadRunningSessions()` at `terminal.js:1688`.
  Its own screen, its own round.
- **The sidebar and its band menu** (`session-sidebar*.js`, 5,175 lines). It is
  visible on the home screen, but it is a different surface with its own group
  endpoints, reorder and rename. It is the natural second screen precisely
  because slice 3's store is the thing it will consume. Migrating both at once
  doubles the blast radius for no gain.
- **`session-restart-picker.js` and the recreate picker** (506 + 485 + 173 + 140
  + 115 lines). The launchpad reaches them, but so do `session-row-menu.js`,
  `session-row-actions.js` and `session-restart-live.js`. They are already
  self-contained modules with a promise-returning `open()`. Svelte calls that
  `open()` unchanged. Migrating them belongs to the sidebar round, when the last
  legacy caller goes.
- **`folder-picker-modal.js`** (280 lines) is called from exactly one place
  (`launchpad.js:6220`) but takes an injected `escapeHtml`. Slice 6 keeps calling
  it and stops injecting; migrate it with the settings round.
- **The plugin registry itself.** See section 6: leave the seam, build nothing.

## 6. The plugin seam: the minimum these slices must do

**Four habits now, no registry file, no types, no loader.**

The recommended `PluginSurface` registry (`sidebar-item`, `launchpad-panel`,
`session-card-action`, `status-source`) is a later, build-time, typed thing. It
can only be added without a rewrite if these slices avoid four specific shapes.

1. **Session-card actions come from a list, not from hardcoded markup.** Slice 5
   renders row controls by mapping over an array of
   `{id, label, icon, enabled(row), run(row)}` built by one function
   (`sessionActions(row)`), not by writing five buttons into the template. This
   is already half true: `SessionRowActions.html()` and `SessionRowMenu` build
   from a list. Keep that, do not flatten it back into markup. Adding a
   `session-card-action` surface later is then one concat.
2. **Panels are mounted by name from one ordered list.** The `mountPanel(id, ...)`
   helper from slice 1 stays the only mount path, and slice 7 keeps one
   `panels.ts` array of `{id, component}` in mount order instead of scattering
   `mount()` calls through the shell. A `launchpad-panel` surface later is one
   more entry in that array.
3. **No component reaches into another component's DOM.** Props down, callbacks
   up, store in the middle. Two existing violations must not be reproduced:
   `app.js:_placeStatusLight` re-parents `#statusText` into the home bar and
   `globalAudioToggle.place` re-parents into `.home-bar`. Slice 7 gives both a
   named anchor element in the home bar component and leaves them re-parenting
   into that anchor; it does not invent a message bus for them.
4. **The status light keeps going through one function.** Every dot renders via
   `StatusLed.ledStateFor` (section 4). That single choke point is what a
   `status-source` surface would extend; a component that inlines its own LED
   markup closes the door.

That is all. Do not write the registry, the surface union, a manifest schema, a
consent flow or a settings page for plugins in these seven slices. The theme
`effects.js` consent pattern in `themes/registry.js` is the precedent to copy
when a runtime rung is actually wanted, and that decision is not in this screen.

## 7. KISS

**Six places this plan could over-build, and the simpler choice taken in each.**

- **Do not port the CSS.** Rewriting 40 stylesheets into Tailwind while also
  porting 6,500 lines of logic doubles the risk and breaks 26 themes. Slices 1
  to 6 keep the existing class names and stylesheets; Tailwind is layout only.
  Revisit after slice 7, or never.
- **One store, not four.** Projects, sessions, records and recent all move
  together on one 5s tick and one join. Splitting them into per-endpoint stores
  buys nothing and makes the join a cross-store `$derived` nobody can read.
- **No event bus between legacy and Svelte.** A direct
  `window.CloudeSvelte.mountPanel(...)` call at the exact line the legacy render
  used to run is one line, greppable, and deleted with its slice.
- **No adapter layer over `api.js`.** Slice 3 calls the existing `window.API`
  methods from TypeScript with hand-written response types. Generating a client
  from the pydantic models is a separate, later, optional job.
- **No Vite dev server.** Strict CSP forbids the HMR inline script and the eval
  websocket shim. Run `vite build --watch` into `client/dist/` and reload the
  page. Slower by a second, and it means what the owner sees is what ships.
- **No abstraction for the three-outcome pattern.** It appears in five places
  (listing, recent state, presence, authority, attribution). Write it out five
  times. A shared `Result<T>` type here would be five imports and one more thing
  to learn, for no deleted line.