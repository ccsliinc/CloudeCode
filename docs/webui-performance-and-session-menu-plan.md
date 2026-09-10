# Make the Web UI substantially faster, synchronize settings, and add the session action menu

## Summary

Prioritize desktop responsiveness, preserve phone support, and trim visual effects when measurements justify it. Optimize the complete interaction path, including backend work that delays typing and notifications.

All themes and durable app settings must be server-owned and shared across computers, browsers, and devices connecting to the same Cloude Code installation. A fresh browser must load the same saved preferences without recreating them locally. Browser storage may accelerate loading but must never be the source of truth.

Fix the reported session-theme regression as an early correctness requirement: a session set to SNES must retain its terminal background, foreground, cursor, and ANSI palette after switching away and returning, as well as its app styling.

The audit found substantial costs before micro-optimizations:

| Area | Evidence |
|---|---|
| Session entry | 500 ms client delay, 50 ms repeated-fit delay, 150 ms server settling wait |
| Sidebar name click | Reproduced 250 ms delay for double-click rename |
| File drawer | Recursive scanning measured 264-361 ms on the server's event loop |
| Toast backfill | 500 records caused 500 renders and about 173 ms of synchronous browser work |
| Settings | No overlay appeared while its request remained pending for over 500 ms |
| Initial loading | 166 scripts and 47 stylesheets; 4.32 MB raw versus approximately 1.39 MB compressed |
| Terminal input | One tmux subprocess per ordinary input event; process startup alone measured about 8 ms median |

These are individual measurements and configured delays, not an additive speedup prediction. The concurrent listing optimization in commit `c8ef6a8` is part of the starting point.

DAR passed after revisions covering terminal ordering, stale navigation, notification recovery, cache retention, and menu accessibility. The global settings addition also passed a focused review, including concurrent config writes and cross-device theme-script consent. The session terminal theme restoration addition passed focused correctness and validation-plan reviews; implementation remains pending.

## Implementation sequence

**1. Establish measurements and fix interaction races.**

- Measure typing through actual rendered echo, session switching, launch, menus, notifications, settings, archive scrolling, and startup. Separate browser scheduling, network, subprocess, database, and agent time.
- Give each navigation intent one generation token shared across sidebar, home, history navigation, restart, fork, and creation. Older completions cannot redirect the current screen.
- Apply the same ownership checks to keyboard, paste, uploads, clipboard, D-pad, and synthetic input. An upload finishing for session A must never insert into B.
- Limit xterm to one bounded in-flight application write. Before switching, discard pending application-owned old output and finish the already-submitted write before resetting the terminal.
- Repair reconnect scheduling, initialization success detection, and retry limits.
- Fix session terminal theme restoration using the shared resolution contract below. This fix can ship independently of the global-settings migration and must remain correct as switching becomes faster.

**2. Remove unnecessary waits from typing, switching, and launching.**

- Remove sidebar double-click rename and its 250 ms arbitration timer.
- Replace unconditional 500 ms connection and 50 ms fit waits with existing font, visibility, and terminal measurement checks.
- Initialize slash commands independently of terminal connection. Enter successfully created sessions before refreshing project decoration.
- Add explicit input readiness after server initialization and configured startup commands. Buffer initial user input by connection generation, without local echo.
- Limit that buffer to 64 KiB of encoded input. Overflow rejects the entire unsent batch with visible feedback. Never replay input after an ambiguous disconnect.
- Skip the server's 150 ms settling wait only when effective geometry is positively confirmed unchanged. Retain conservative handling for changed, failed, or unknown geometry.
- Remove the extra application animation-frame delay before isolated xterm writes; coalesce bursts without adding a typing debounce.
- Fix resize-source priority, duplicate fits, and waits after transitions have already finished.
- Batch compatible tmux launch setup while preserving environment injection, streaming setup, error handling, and the 250 ms dead-on-arrival observation.

**3. Stop background and request work from blocking terminal traffic.**

- Move blocking tmux, SQLite, filesystem, and identified status/archive operations off the event loop.
- Keep mutable session state on the event loop. Collect immutable evidence elsewhere, then reject stale results using socket, session instance, addressed pane, and activity revision.
- Batch database decoration inside short deferred read transactions. Avoid repeated connections and per-session queries where bulk evidence exists.
- Use targeted raw probes for launch/adoption bookkeeping instead of constructing decorated lists of every session.
- Correct listing completeness and delimiter parsing before trusting absence. A partial listing must never remove a live session.
- Keep required and optional tmux commands in batches with compatible failure behavior.
- Bound work admission and reserve interactive capacity. Cancelled requests retain capacity until their underlying work actually finishes.
- Offload the existing file-tree operation first, then fetch unopened directories only when expanded, retaining containment and sensitive-file rules.

**4. Share state updates and make notifications immediate.**

- Share sidebar/home requests by query scope and authentication generation. Run independent reads concurrently, with one in-flight refresh and one trailing refresh when invalidated.
- Patch changed status, unread, and active-selection nodes in place. Preserve unrelated rows, editing, focus, scroll, dragging, and open menus.
- Add an authenticated application event connection that works on home and while viewing another session. Send compact status changes and toast events; reserve full refreshes for structural changes.
- Retain five-second reconciliation for external tmux changes and event-connection failure.
- Analyze terminal output once per originating session, including sessions without viewers. Carry source identity and replay classification through local-server detection.
- Fan out raw bytes internally. Give each viewer an independent bounded queue and one socket writer. An overflowing viewer reconnects and recaptures; it cannot stall other viewers or cause arbitrary ANSI bytes to be dropped.
- Batch toast backfill and bulk dismissal into one rendering pass. Skip identical updates while preserving changed versions of an existing toast.
- Dispatch enabled external notification channels concurrently within the existing queue and rate-limit policy.

**5. Make themes and app settings global across devices.**

- Inventory every durable browser-stored preference and migrate its ownership to the existing server settings or appropriate project/session store.
- Implement the global settings contract below before finalizing theme caching, settings startup, and preference-driven rendering optimizations.
- Synchronize committed changes to other connected clients through the application event connection, preserving immediate local feedback and explicit save failures.

**6. Reduce startup, rendering, and secondary-interaction costs.**

- Lazy-load archive and editor dependencies using native same-origin script loading. Keep route parsers eager, download independent resources concurrently, execute dependencies in order, and retry only failed resources.
- Compress static text outside request handling. Introduce immutable caching only for URLs bound to exact content.
- Keep mutable themes and unversioned source URLs revalidating. Preserve CSP, content types, conditional requests, and audio/range behavior.
- Mount settings and picker shells immediately. Keep controls requiring fetched data disabled until a successful read; provide real retry states.
- Fetch independent provider and editor-root data concurrently. Dispose listeners on close and replacement.
- Preserve archive row nodes when the visible window is unchanged. Invalidate content when bodies, selection, or disclosure policies change.
- Cache normalized filter data and header measurements. Skip unchanged theme-variable and storage writes without skipping required theme/audio semantics.
- Apply final drawer/sidebar geometry immediately where appropriate; retain only inexpensive cosmetic animation.

**7. Pursue the remaining 5 ms opportunities through bounded experiments.**

- Test native macOS append notifications against the existing durable terminal-output file, replacing the 20 ms polling interval while preserving restart, rotation, and adoption behavior.
- Test a persistent [tmux control-mode](https://github.com/tmux/tmux/wiki/Control-Mode) input channel to avoid subprocess startup for every key.
- Promote either only after repeated, matched measurements show at least 5 ms improvement in user-visible median latency above measurement variation, without material tail-latency, CPU, memory, throughput, or correctness regression.
- Preserve existing transport fallbacks. An uncertain command acknowledgement must never trigger automatic replay.

## Global themes and app settings

The required outcome is one persistent set of preferences for this Cloude Code installation, available from every authenticated client. Switching computers, clearing browser storage, opening a private window, or restarting the server must not lose the saved settings. This is shared server persistence, not synchronization between separate Cloude Code server installations.

**Coverage and ownership.**

- Cover the default theme and theme options; audio enablement and volume; sidebar visibility, pinning, density, arrangement, and collapsed groups; drawer pinning and preferred widths; editor-tree folds; archive ordering, layout, and saved filter preferences; remembered provider/model selections; and every other durable app preference discovered during the storage inventory. Audit all localStorage, sessionStorage, and ad hoc persistence call sites rather than stopping at the settings screen.
- Keep existing server-backed agent, workspace, notification, project, group, and session settings in their current authoritative stores. Add a typed, versioned `ui_preferences` block to the existing server settings for global UI preferences that currently have no server owner. Do not introduce a second copy of an already-server-owned setting.
- Preserve intentional project/session theme overrides and per-session settings, with those values also shared across devices. The app settings theme control edits the global default; explicit project/session controls edit their named scopes. Merely having a session open must not turn a global theme change into an accidental session override. Preserve the established theme precedence.
- Serve custom themes and their resources from the server so selecting a theme on one computer makes the same theme available on another. Preserve existing theme validation, same-origin delivery, CSP, and script-consent gates. Persistent Always/Never effects choices are shared settings; selecting a theme is not permission to run its script, and Allow once remains a temporary action.
- Hydrate authoritative script consent before executing theme effects. A cached approval, pending prompt, or in-flight load cannot outrank a newer global Never. Invalidate stale prompts/loads on policy changes and invoke existing effects teardown on revocation; do not claim previously executed JavaScript can be retroactively undone.
- Authentication tokens, clipboard contents, unsent terminal input, focus/caret state, and browser-enforced autoplay/device permissions are not shared app preferences. Keep secrets in their existing protected server stores with masked/write-only API behavior; never copy them into preference snapshots, browser caches, logs, or event payloads.

**Persistence and synchronization.**

- Extend the existing authenticated settings read/write flow and atomic config persistence, including pre-write backup, fsync, and replacement. Preserve unknown additive config keys for downgrade compatibility. The fresh read, revision check, merge, backup, and replacement share one serialization boundary across every application config writer, not just the new preference endpoint. Atomic replacement alone does not prevent concurrent lost updates or collisions on a shared temporary file.
- Send validated partial updates, with revision checks that reject stale overlapping edits instead of silently overwriting a newer choice. Return the committed values and revision. Other clients receive a `preferences.changed` event with the committed revision and safe non-secret changed fields; reconnect performs an authoritative refresh.
- Hydrate preferences during authenticated app startup before initializing preference-dependent controls. Keep the UI preference projection small and cached in server memory so synchronization does not become a new filesystem or database operation per keystroke, render, or session switch.
- Treat browser values as optional caches keyed to the server installation and preference revision. Server values win on reconnect; applying a received setting must not generate a save echo. Failed reads never cause defaults to be saved over real settings, and stale responses cannot undo newer revisions.
- Apply deliberate user choices locally for immediate feedback while reporting their pending save. Confirm persistence only after the server commits. On failure, keep a visible retry/error state and distinguish the unsaved choice from the committed setting. Reconcile pending edits before retrying after reconnect; never upload an old whole-browser snapshot automatically.
- Share preferred layout values while adapting their rendered geometry to the current viewport. A phone may clamp a drawer width or temporarily present a pinned panel as an overlay without saving that adaptation over the desktop preference. Write preferences on completed user actions, not every resize, animation frame, or pointer movement.

**Migration of existing browser preferences.**

- Provide a one-time, explicit `import settings from this browser` flow with a preview of recognized values. Import only allowlisted, validated preference fields. Existing server settings take precedence; replacing a conflicting server value requires an explicit selection in that import flow.
- Do not scrape arbitrary browser storage or infer theme-script approval from a theme selection. Retain the local source until the server confirms the import, and record migration completion so a later stale browser cannot silently reseed shared preferences.
- After migration, ordinary settings changes save globally without a separate import or confirmation. A new browser reads the server configuration directly and does not need the old browser to be open.

## Session terminal theme restoration

**Reported behavior and confirmed failure path.** The owner's September 9 screenshots show SNES styling immediately after selection, followed by a dark terminal with the original palette after leaving and returning; the surrounding app still has SNES styling. Inspection at commit `2b1fcb9` found two competing theme writers:

- [/Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/client/js/app.js](</Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/client/js/app.js>) calls `ThemeNavigation.applyForSession()` and then `Themes.applySession(agentType)` in both `showTerminal()` and `returnToExistingTerminal()`.
- [/Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/client/js/theme-navigation.js](</Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/client/js/theme-navigation.js>) explicitly restores the saved pin to the page and xterm, but the later agent-scoped call in [/Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/client/js/themes/registry.js](</Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/client/js/themes/registry.js>) can replace terminal CSS variables and the xterm palette with a matching agent manifest.
- First initialization can hide the conflict: [/Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/client/js/terminal.js](</Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/client/js/terminal.js>) seeds xterm from `getActiveGlobal().xterm`; on a warm return its existing listener receives the later agent palette instead.

A read-only reproduction using the shipped registry, navigation module, and SNES/Claude palette data confirmed the overwrite: selection emitted SNES background `#3A3A40` and cyan `#3CC4B5`; re-entry followed by `applySession('claude')` emitted background `#1e1e1e` and cyan `#11a8cd`, while the page theme remained `snes`. This confirms a client-side failure path matching the screenshots, not a measurement of the reported live session's payload. Null or unknown agents take a different fallback path and must also be tested.

**Planned shared fix.**

1. Resolve the navigation target's effective theme once through the existing navigation/registry pipeline. A valid explicit session/project theme wins over an agent fallback for both terminal CSS scope and the complete xterm palette. Preserve intentional unpinned agent/global fallback behavior, and keep the stored global default distinct from the currently painted session pin. Use the existing server-resolved pin rather than inventing another project/session persistence mechanism.
2. Remove or redirect the competing agent-only paint in both entry paths. Make initial terminal construction and later theme updates consume the same resolved terminal palette. Immediate picker changes must update that same effective state, so leaving and returning cannot undo a saved choice. Do not repair this with per-caller repaint copies, forced terminal recreation, new requests, or delayed theme timers.
3. Remove obsolete terminal-scoped CSS variables when their owner changes. Keep the existing background-opacity adapter as the only opacity transform; foreground and ANSI colors remain those of the resolved manifest. Preserve effects consent, teardown, and audio behavior.
4. Keep any deferred theme application tied to the current navigation/selection. A stale agent or replay completion must not overwrite a newer session or picker choice. The registry exposes a replay gate, but no production caller of its setter was found in this inspection; do not claim replay caused the reported defect or add a new replay mechanism solely for this fix.

**Regression and acceptance checks.** Extend the existing suites at [/Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/tests/test_theme_follows_navigation.node.mjs](</Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/tests/test_theme_follows_navigation.node.mjs>) and [/Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/tests/test_theme_follows_navigation_renders.py](</Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/tests/test_theme_follows_navigation_renders.py>), or add a focused sibling where needed. The current Node suite stubs `applySession()`; the browser suite stubs the terminal and measures a page-background probe with a null agent. Neither proves the terminal palette survives a recognized agent's later paint.

- Reproduce the failure before changing production code, then exercise the real registry/navigation/application paths with the real xterm renderer and opacity adapter. Use SNES and an agent whose id matches a theme manifest.
- Verify SNES -> differently themed session -> SNES, SNES -> home -> SNES, first attachment, an existing terminal, and reconnect/reset. Compare effective xterm options and rendered terminal background, foreground, cursor, and representative ANSI swatches against the shipped SNES manifest, accounting for the existing opacity transform. Check scoped CSS variables and app chrome after the full entry sequence settles, not just immediately after navigation requests a theme.
- Cover unpinned sessions, pin removal, null/unknown/wrapper agent ids, unavailable theme ids, rapid A/B/A switching, a picker change during pending work, and effects becoming visible or inactive. Confirm neither stale CSS nor a previous palette reappears.
- Have the validator agent verify actual terminal pixels in an isolated real-browser harness, with desktop/Electron prioritized and phone coverage retained. Do not attach to or resize the user's live panes. Run relevant Node tests and `node --check` on changed JavaScript; preserve the existing navigation and opacity gates.

This addition is a plan with a source-level reproduction. No application fix or new browser-rendered acceptance result is claimed yet.

## Session action menu

Replace the live-session X with a shared vertical three-dot menu on sidebar and home session rows.

| Label | Shortcut | Behavior |
|---|---|---|
| `rename` | R | Open the existing validated inline editor |
| `fork session` | F | Create and immediately open the fork; preserve the original |
| `new session in folder` | N | Open the existing provider/wrapper picker for that row's recorded working directory |
| `mute notifications` / `unmute notifications` | M | Persist notification suppression for that session everywhere |
| `close session` | C | Run the existing close confirmation and teardown |

Place close below a separator. Preserve existing dead-session restart/remove behavior and truthful confirmation wording.

Menu behavior:

- Open immediately without waiting for requests.
- Show shortcut letters right-aligned in the muted text color.
- Bind letters only while open. Ignore modifiers, repeats, composition, and editable input; handled keys never reach the terminal.
- Focus the first item and support arrows, Home, End, Enter, Space, and Escape.
- Unavailable actions remain focusable with an accessible explanation and cannot activate.
- Escape restores trigger focus. Tab and outside clicks retain their destination focus.
- Constrain the popup to the visual viewport, with internal scrolling when needed.
- Capture the clicked row's identity. Refreshes or later navigation cannot redirect an action to another session.
- Fork/create completion opens its child only while that originating navigation remains current.
- Preserve F2 and title-based rename; remove double-click behavior completely.

Mute semantics:

- Persist on the durable session record, surviving server restart and same-record session restart.
- Suppress current and future web alerts and external pushes while preserving activity, unread indicators, attachment receipts, and action errors.
- Do not acknowledge permission notifications merely because they were muted.
- Unmute resumes future alerts without replaying a backlog.
- New sessions and forks start unmuted.
- Queue entries carry notification-policy generations so an old alert cannot escape after a mute/unmute cycle.
- Resolve persisted policy before notification producers start. Failed preference reads must not default a muted session to unmuted.

## Interfaces and correctness requirements

Add focused modules and reuse existing action, state, menu, and transport helpers.

Public additions:

- Readiness capability on the existing dimension handshake and an additive `terminal.ready` message.
- `/ws/events` for application-level status, notification, and structural updates.
- A typed, versioned `ui_preferences` projection and conditional partial updates through the existing authenticated settings API, plus `preferences.changed` application events. Existing server-owned settings retain their current APIs and storage.
- An authoritative pending-toast snapshot with server boot identity and watermark.
- Toast versions and optional expected-version acknowledgements.
- Optional instance filtering/pagination for session records and shallow directory reads.
- `PATCH /api/v1/sessions/records/{session_uuid}/notifications` with `{muted: boolean}`.
- Durable notification mute and policy-generation fields, exposed through session state.
- Expected-instance checks for row actions that could otherwise target a reused session name.

Notification recovery subscribes before snapshot acquisition, replaces only the complete server-owned toast subset, and then applies newer events. Partial or failed snapshots never clear existing state; local attachment receipts survive recovery.

Keep explicit resource bounds:

- Terminal viewer queues: 4 MiB or 256 chunks.
- Application event queues: 1 MiB or 256 events.
- Shared response cache: 32 query scopes or 8 MiB, with lifecycle eviction.
- Bulk scans: two concurrent jobs with bounded admission and guaranteed reconciliation service.
- Static cache: 256 MiB, protecting current/previous generations and generations published within seven days. If publication cannot honor retention, use revalidating source URLs for the new shell instead of evicting protected assets.

Compatibility limits remain explicit: older clients retain legacy acknowledgement semantics; already-painted legacy toast cards require reload to honor mute. Pending toasts remain in memory. The existing capture/live-output overlap is not claimed to be atomic; preserve its ordering and test changes against real panes rather than draining queues or guessing offsets.

## Validation and delivery

Initial desktop loopback targets, to be verified:

| Interaction | Target |
|---|---|
| Deterministic terminal echo | p95 at or below 50 ms |
| Warm switch with unchanged geometry | p95 at or below 200 ms |
| Click/menu feedback | Within one 60 Hz frame |
| Local hook to visible toast | p95 at or below 100 ms |

Measure agent startup and external-service latency separately. A parser callback is not proof of painted output; use xterm rendering evidence as described by its [terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/).

Acceptance covers:

- Cold/warm runs with 1, 10, and 50 sessions; sustained output, idle CPU, memory, and request counts.
- Rapid switching, reordered responses, asynchronous xterm writes, upload completion, paste, Unicode/IME, reconnect, and resize failures.
- The session terminal theme restoration matrix above, including actual SNES terminal pixels after leaving and returning with a recognized agent theme present.
- Partial listings, reused names, changed panes, hooks arriving during reads, database contention, worker saturation, and launch failures.
- Toast snapshot/event/ACK reorderings, mute persistence, delayed external queues, slow viewers, and local receipt preservation.
- Every menu action and shortcut, focus behavior, disabled explanations, narrow/short viewports, zoom, and both light and dark themes.
- Two independent browser contexts with separate storage: change each preference family in A, verify committed changes appear in B without reload, and verify a fresh client C starts with the same values. Repeat after server restart and clearing local storage.
- Browser-preference import, existing-server-value conflicts, concurrent edits, delayed responses, disconnect/reconnect, failed saves, and blocked browser storage. Verify project/session overrides agree across devices, responsive layout does not rewrite global preferences, script-consent semantics remain intact, and secrets never enter synchronization payloads.
- Lazy-load failure/retry, old-tab loading after deployment, cache exhaustion, archive disclosure changes, and listener cleanup.

The validator agent must verify implemented UI behavior in real browsers, with desktop/Electron prioritized and phone checks retained. Cross-device settings must be tested using independent browser storage contexts, not two tabs sharing localStorage. Existing selected Node tests and Chromium toast gates passed during the original audit; future UI behavior, global settings synchronization, and end-to-end gains remain unverified.

Append measurements and progress to [/Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/TODO.md](</Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/TODO.md>). Deliver focused commits after relevant tests, `node --check`, and security review. Deployment is outside this plan's authorization.
