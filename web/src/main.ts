/**
 * Entry point for the Svelte half of the app.
 *
 * WHAT LOADING THIS DOES TO THE RUNNING APP: nothing visible. It
 * publishes one namespace, `window.CloudeWeb`, and returns. It mounts no
 * component into the document, registers no listener, touches no existing
 * element and overwrites no existing global. That is the contract for
 * this round of the migration - the bundle ships and proves itself, and
 * the screens change later, one at a time.
 *
 * WHY A NAMESPACE AT ALL. The legacy tree is a set of IIFEs that publish
 * onto `window`, and it has to be able to call into the compiled tree
 * during the migration without either side importing the other. One
 * namespace, named after the tree it belongs to, is the seam. Add exports
 * to it as screens move over; do not scatter new globals beside it.
 *
 * NO INLINE SCRIPT, EVER. This file and everything it imports are bundled
 * into client/dist/app.js and loaded with a plain `<script type="module"
 * src>` from this app's own origin. `script-src 'self'` forbids inline
 * script and `eval`, so nothing here may reach for either, and no build
 * setting may be changed to make Vite emit them.
 */
import './app.css';
import { mount, unmount } from 'svelte';
import StatusLed from './lib/StatusLed.svelte';
import * as led from './lib/led';
import { ledHtmlForStatus, labelFor, labelWithSource, normalizeStatus } from './lib/status-dot';
import type { StatusSignals } from './lib/status-dot';
import { ensurePanel, mountPanel, unmountPanel } from './lib/mount';
import { browserCreateHost, type CreateHost } from './lib/launchpad/create-host';
import { browserModals } from './lib/launchpad/modals';
import { createConsoleFlow, createProjectFlow } from './lib/launchpad/create-flow';
import {
    cloneFromGithubFlow,
    startNewClaudeProject as startNewClaudeProjectFlow,
    startSessionInExistingProject as startSessionInExistingProjectFlow,
} from './lib/launchpad/entry-flows';
import { openProjectFromFolderFlow } from './lib/launchpad/open-folder-flow';
import {
    archiveProjectFlow,
    editProjectFlow,
    unarchiveProjectFlow,
} from './lib/launchpad/project-actions';
import type { ProjectRow } from './lib/sessions/types';
import AttributionPrompt from './lib/launchpad/AttributionPrompt.svelte';
import RecentSessions from './lib/launchpad/RecentSessions.svelte';
import ProjectTree from './lib/launchpad/ProjectTree.svelte';
import RunningSessions from './lib/launchpad/RunningSessions.svelte';
import {
    archiveSessionRecord,
    browserHost as recentBrowserHost,
    forkSession,
    restartRecentSession,
} from './lib/launchpad/recent-actions';
import type { RestartOptions } from './lib/launchpad/recent';
import { sessionStore } from './lib/sessions/store.svelte';
import { defaultShouldPoll } from './lib/sessions/poller';
import { workStampFor } from './lib/sessions/attribution';
import {
    derivedDisplayName,
    sessionDisplayLabel,
    type NameableRow,
} from './lib/sessions/session-label';
import type { RunningSessionRow } from './lib/sessions/types';
import { uiPrefs } from './lib/ui/prefs.svelte';
// Imported for its side effect: this is what registers the shipped
// plugins on the surface registry. Nothing reads a binding from it.
import './lib/plugins/builtin';
import { sessionCardMenuItems, runSessionCardAction } from './lib/plugins/session-card-actions';
import { t, setLocale, currentLocale, i18n } from './lib/i18n/index.svelte';
import { summaryLabel } from './lib/session-summary-label';
import { mountHomeScreen, launchpadScreen, unmountHomeScreen } from './lib/launchpad/home-screen-host';
import { mountLaunchpadPanels, refreshLaunchpadPanels } from './lib/launchpad/panels';
import { publishLaunchpadShim } from './lib/launchpad/shim';
import { browserNavHost } from './lib/launchpad/nav-host';
import {
    connectToExistingSession as connectToExistingSessionFlow,
    detachAndCreateNew as detachAndCreateNewFlow,
    detachAndOpenProject as detachAndOpenProjectFlow,
    explainRefusedProject,
    isResolvingDeepLink,
    openProjectByName as openProjectByNameFlow,
    selectProject as selectProjectFlow,
} from './lib/launchpad/navigation';
import { showError as showHomeError, updateStatus } from './lib/launchpad/status-report';
import type { FabAction } from './lib/launchpad/new-fab';

/** The id of the container `renderLaunchpadUI()` writes for the card. */
const ATTRIBUTION_PROMPT_CONTAINER = 'attribution-prompt';

/** The id of the container `renderLaunchpadUI()` writes for RECENT. */
const RECENT_SESSIONS_CONTAINER = 'recent-sessions-list';

/** The id of the container `renderLaunchpadUI()` writes for the tree. */
const PROJECT_TREE_CONTAINER = 'project-list';

/** The id of the container the launchpad writes for the running list. */
const RUNNING_SESSIONS_CONTAINER = 'running-sessions-list';

/**
 * The host the three exported RECENT actions use when a legacy caller
 * invokes one directly.
 *
 * Description: built ONCE at module load rather than per call, because
 *   `browserHost` resolves `window.API` and `window.Launchpad` lazily
 *   inside each method anyway - so one object is enough and a second
 *   would only be a second `refreshRecent` closure over the same store.
 *   The component builds its own by default, which is the same shape;
 *   both end up calling this one store.
 */
const recentHost = recentBrowserHost(() =>
    sessionStore.refreshRecent(
        (includeArchived) => recentHost.fetchRecent(includeArchived),
        uiPrefs.archivedSessionsVisible,
        t,
    ),
);

/**
 * Mount the Stage C attribution prompt into the launchpad's own slot.
 *
 * Description: THE ONE LINE `client/js/launchpad.js` CALLS. It sits at
 *   the exact point `loadProjects()` used to call the five legacy
 *   attribution methods, which were deleted in the same commit. Kept as
 *   a named function rather than a bare `mountPanel` call at the call
 *   site so the container id lives in this tree, where the component
 *   does, and so the legacy line stays greppable and one line long.
 *
 *   The card fetches its own question set as it mounts, exactly as
 *   `loadAttributionPrompt()` did. Nothing is awaited here: a failure
 *   inside it must not stop the projects rendering.
 * Inputs: none.
 * Output: void.
 * Example: window.CloudeWeb.launchpad.mountAttributionPrompt();
 */
function mountAttributionPrompt(): void {
    mountPanel(ATTRIBUTION_PROMPT_CONTAINER, AttributionPrompt, {});
}

/**
 * Mount the RECENT sessions section into the launchpad's own slot.
 *
 * Description: THE ONE LINE `client/js/launchpad.js` CALLS for slice 2.
 *   It sits at the exact point `loadProjects()` used to call
 *   `loadRecentSessions()`, which was deleted in the same commit along
 *   with eight sibling methods and `session-recent-visibility.js`.
 *
 *   The component fetches `GET /sessions/recent` as it mounts, exactly
 *   as `loadRecentSessions()` did, and also takes over the section's
 *   count badge, its archive filter and its own visibility - all three
 *   of which live in the heading OUTSIDE this container, and are written
 *   rather than re-rendered so the legacy collapse binding survives.
 *   Nothing is awaited: a failure inside it must not stop the projects
 *   rendering, and a non-ok state is a thing it RENDERS rather than a
 *   thing it throws.
 * Inputs: none.
 * Output: void.
 * Example: window.CloudeWeb.launchpad.mountRecentSessions();
 */
function mountRecentSessions(): void {
    mountPanel(RECENT_SESSIONS_CONTAINER, RecentSessions, {});
}

/**
 * Mount the project tree into the launchpad's own slot.
 *
 * Description: THE ONE LINE `client/js/launchpad.js` CALLS for slice 4,
 *   and it is the whole of `renderProjectList()` now. It sits at the
 *   exact point that method's `innerHTML` write used to run, along with
 *   the sixteen methods deleted in the same commit and
 *   `client/js/project-list-render-guard.js`.
 *
 *   `ensurePanel`, NOT `mountPanel`, AND THAT IS THE PERFORMANCE CLAIM'S
 *   SEAM. `renderProjectList()` is called on every 5s poll tick and from
 *   five other places. A `mountPanel` here would unmount and rebuild the
 *   whole tree every five seconds - exactly the repaint this slice
 *   deletes, reintroduced by the seam rather than by the renderer. This
 *   is a no-op once a live panel is mounted on the element that
 *   currently carries the id, so the tick costs one map lookup and the
 *   tree updates because it READS the store, not because anybody told it
 *   to paint.
 * Inputs: none.
 * Output: void.
 * Example: window.CloudeWeb.launchpad.mountProjectTree();
 */
function mountProjectTree(): void {
    ensurePanel(PROJECT_TREE_CONTAINER, ProjectTree, {});
}

/**
 * Mount the running-sessions list into the launchpad's own slot.
 *
 * Description: THE ONE LINE `client/js/launchpad.js` CALLS for slice 5,
 *   and it is the whole of `renderRunningSessions()` now. It sits at the
 *   exact point that method's `innerHTML` write used to run, along with
 *   the fifteen methods and `_lastRunningSig` deleted in the same commit,
 *   `client/js/session-list-busy-guard.js` and
 *   `client/js/launchpad-wrapper-pill.js`.
 *
 *   `ensurePanel`, NOT `mountPanel`, for the reason slice 4 gave:
 *   `loadRunningSessions()` calls this on every 5s poll tick and after
 *   every row action, and a `mountPanel` here would unmount and rebuild
 *   the whole list each time - the exact repaint this slice deletes,
 *   reintroduced by the seam rather than by the renderer.
 * Inputs: none.
 * Output: void.
 * Example: window.CloudeWeb.launchpad.mountRunningSessions();
 */
function mountRunningSessions(): void {
    ensurePanel(RUNNING_SESSIONS_CONTAINER, RunningSessions, {});
}

/**
 * The display name for one session row, for a legacy caller.
 *
 * Description: `client/js/app.js:1403` derives a deep-link slug from the
 *   launchpad's own display rule, reused rather than reimplemented, and
 *   it is the one caller of `_deriveRunningSessionDisplayName` outside
 *   this surface. It survives as a shim on `Launchpad` until slice 7
 *   deletes that file; this is where the rule now lives.
 * Inputs: tmuxName - the literal tmux session name.
 * Output: string - the `cloude_`-stripped name.
 * Example: window.CloudeWeb.launchpad.displayNameFor('cloude_api')  // 'api'
 */
function displayNameForLegacy(tmuxName: string | null): string {
    return derivedDisplayName(tmuxName);
}

/**
 * The string a HUMAN should see for one session row, for a legacy caller.
 *
 * Description: delegates to `client/js/session-label.js`, the shared
 *   module the sidebar row, the tab title, the in-page header and the
 *   toast cards all read. Exported because the project tree's rows reach
 *   it through `project-tree-host.ts`, which called
 *   `Launchpad._sessionDisplayLabel` until this slice deleted that.
 * Inputs: row - anything carrying `label` and `name`.
 * Output: string.
 * Example: window.CloudeWeb.launchpad.sessionDisplayLabel(row);
 */
function sessionDisplayLabelForLegacy(row: NameableRow | null): string {
    return sessionDisplayLabel(row);
}

/**
 * The project archive filter, for a legacy caller.
 *
 * Description: `Launchpad.loadProjects()` decides what to REQUEST, and
 *   the filter it reads is a per-device preference that moved into
 *   `./lib/ui/prefs.svelte.ts` with the rest of the tree's state in
 *   slice 4. Exported as a FUNCTION rather than a value because the
 *   preference is resolved lazily on first read and can be flipped by
 *   the tree between two calls; a value would be a snapshot taken at
 *   import, which is the whole reason the store exports accessors.
 * Inputs: none.
 * Output: boolean.
 * Example: window.CloudeWeb.launchpad.archivedProjectsVisible();
 */
function archivedProjectsVisible(): boolean {
    return uiPrefs.archivedProjectsVisible;
}

/**
 * Whether the launchpad screen is the one on display.
 *
 * Description: `client/js/project-list-render-guard.js` held this as
 *   `shouldPoll`, and slice 4 deleted that file. The predicate is
 *   unchanged and so is its THIRD OUTCOME: false only for a MEASURED
 *   hidden, because an unknown screen state must keep polling rather
 *   than silently stop refreshing the app. The poller reaches it through
 *   `./lib/sessions/poller.ts`, which is where it now lives; this export
 *   exists because `client/js/launchpad.js` has no way to import one.
 * Inputs: none. Output: boolean.
 * Example: window.CloudeWeb.launchpadIsVisible()
 */
function launchpadIsVisible(): boolean {
    return defaultShouldPoll();
}

/**
 * Archive one stored session record, for a legacy caller.
 *
 * Description: the project tree's ended rows still live in
 *   `launchpad.js` (slice 4) and offer this control. Rather than leave a
 *   second copy of the behaviour there, that row calls this. ONE
 *   implementation, one greppable call site per surface.
 *
 *   IT IS A SOFT ARCHIVE. `archived_at` is stamped and the row keeps
 *   every column; a restart is what brings it back. Never confuse it
 *   with the X on a running row, which stops a process.
 * Inputs: sessionUuid - the stored row's durable key.
 * Output: Promise<void>. Failures are reported inline, never thrown.
 * Example: await window.CloudeWeb.launchpad.archiveSessionRecord('a1b2');
 */
function archiveSessionRecordForLegacy(sessionUuid: string | null): Promise<void> {
    return archiveSessionRecord(sessionUuid, recentHost, t);
}

/**
 * Fork a running session, for a legacy caller.
 *
 * Description: the running-sessions row is slice 5 and still legacy, and
 *   its fork control calls this. See ./lib/launchpad/recent-actions.ts
 *   for why a 409 is a refusal that gets said out loud.
 * Inputs: tmuxName - the PARENT session's tmux name.
 * Output: Promise<void>.
 * Example: await window.CloudeWeb.launchpad.forkSession('cloude_work');
 */
function forkSessionForLegacy(tmuxName: string | null): Promise<void> {
    return forkSession(tmuxName, recentHost, t);
}

/**
 * Restart a stopped session, for a legacy caller.
 *
 * Description: the project tree's ended rows call this, and so do the
 *   RECENT rows through the component. Both reach the same plan and the
 *   same three-outcome notice.
 * Inputs: opts - {sessionUuid, title, workingDir, agentType}.
 * Output: Promise<void>.
 * Example: await window.CloudeWeb.launchpad.restartRecentSession({...});
 */
function restartRecentSessionForLegacy(
    opts: Partial<RestartOptions> | null,
): Promise<void> {
    return restartRecentSession(opts, recentHost, t);
}

/**
 * Load the project list and both its sidecars, for a legacy caller.
 *
 * Description: SLICE 3, AND THE STORE IS THE ONLY OWNER OF THE RESULT.
 *   `Launchpad.loadProjects()` is now a sequencer: it awaits this, paints
 *   through its own still-legacy renderers, and holds nothing. The
 *   failure sentence comes back rather than being shown from in here,
 *   because the inline error line is a legacy surface this tree does not
 *   own yet.
 * Inputs: includeArchived - the per-device toggle as it stands now.
 * Output: Promise with `ok` and, on failure, the message to show.
 * Example: await window.CloudeWeb.launchpad.loadProjects(false);
 */
function loadProjectsForLegacy(
    includeArchived: boolean,
): Promise<{ ok: boolean; error: string | null }> {
    return sessionStore.loadProjects(!!includeArchived, t);
}

/**
 * Refetch and re-merge the running-session set, for a legacy caller.
 *
 * Description: the two-endpoint merge, the dead-pane filter, the
 *   attribution join, the work-stamp index and the sort - everything the
 *   274-line `loadRunningSessions` did except the two render calls, which
 *   stay with the renderers that slices 4 and 5 own.
 * Inputs: none.
 * Output: Promise<void>. Never rejects.
 * Example: await window.CloudeWeb.launchpad.loadRunningSessions();
 */
function loadRunningSessionsForLegacy(): Promise<void> {
    return sessionStore.loadRunningSessions(t);
}

/**
 * Refetch the stored session records alone, for a legacy caller.
 *
 * Description: the row actions refresh attribution without re-probing
 *   tmux. Same join, same work index, same three-outcome latch.
 * Inputs: none. Output: Promise<void>. Never rejects.
 * Example: await window.CloudeWeb.launchpad.loadSessionAttribution();
 */
function loadSessionAttributionForLegacy(): Promise<void> {
    return sessionStore.loadSessionAttribution(t);
}

/**
 * The `last_work_at` for one running-session row, for a legacy caller.
 *
 * Description: `_workRecencyAttrs` is a tree renderer and stays in
 *   `launchpad.js` until slice 4, and it is the one surviving caller of
 *   the lookup that moved. Exported so it reads the SAME index the sort
 *   reads, rather than keeping a second copy of a three-line map get -
 *   two copies of a lookup are two answers the moment one is updated.
 * Inputs: row - a running-session row with `name`.
 * Output: string | null - an ISO stamp, or null for UNRECORDED.
 * Example: window.CloudeWeb.launchpad.workStampFor(row);
 */
function workStampForLegacy(row: RunningSessionRow | null): string | null {
    return workStampFor(row, sessionStore.workStampByName);
}

/**
 * Start the one 5s running-sessions tick.
 *
 * Description: THE POLL AND ITS TEARDOWN NOW LIVE TOGETHER.
 *   `Launchpad._startRunningSessionsPoller` called `setInterval` and the
 *   word `clearInterval` appeared nowhere in that file, so the tick
 *   outlived every teardown there has ever been. `stopSessionPolling` is
 *   the missing half.
 *
 *   The tick's own work is passed IN, because what a tick does is
 *   refetch AND repaint, and the repaint is still legacy until slices 4
 *   and 5. The two gates - signed in, and the launchpad screen still
 *   active - live in the poller and read the same globals they always
 *   did.
 * Inputs: tick - what one tick does.
 * Output: void.
 * Example: window.CloudeWeb.launchpad.startSessionPolling(() => lp.loadRunningSessions());
 */
function startSessionPolling(tick: () => Promise<unknown> | unknown): void {
    sessionStore.startPolling({ tick });
}

/**
 * Stop that tick and clear its interval.
 *
 * Inputs: none. Output: void.
 * Example: window.CloudeWeb.launchpad.stopSessionPolling();
 */
function stopSessionPolling(): void {
    sessionStore.stopPolling();
}

/**
 * Render the StatusLed component once, off-document, and hand back its
 * markup.
 *
 * Description: THE END-TO-END PROOF, and the reason it renders into a
 *   detached element. Everything else this bundle exports is a pure
 *   string function, which would compile and pass its tests even if the
 *   Svelte runtime were broken or absent in the browser. This actually
 *   mounts a compiled Svelte 5 component with runes and reads what the
 *   real DOM made of it - and it does so in a container that was never
 *   inserted into the document, so it cannot paint a pixel, shift a
 *   layout or be found by any selector the legacy code runs.
 *
 *   Called on demand, never at load: a bundle that mounted something on
 *   every page load would be doing work for a diagnostic.
 * Inputs:
 *   status - raw `activity_status` value.
 *   signals - the wrapper-level fields, as ledHtmlForStatus takes them.
 * Output: string - the component's rendered outerHTML.
 * Example:
 *   window.CloudeWeb.renderProbe('working', {unread: false})
 *   // '<span class="inline-flex items-center gap-1.5 align-middle">...'
 */
function renderProbe(status?: string | null, signals?: StatusSignals | null): string {
    const s: StatusSignals = signals || {};
    const host = document.createElement('div');
    const component = mount(StatusLed, {
        target: host,
        props: {
            status: status ?? null,
            unread: !!s.unread,
            startupGate: s.startup_gate ?? null,
            statusSource: s.status_source ?? null,
            size: s.size ?? null,
        },
    });
    const html = host.innerHTML;
    // Unmounted immediately. The probe owns nothing after it answers, so
    // repeated calls cannot accumulate live component instances.
    unmount(component, { outro: false });
    return html;
}


// ---- slice 6: the modals and the create flows ------------------------
//
// EVERY ONE OF THESE IS A WRITE, which is why they are forwarders rather
// than components: the legacy FAB, the terminal-commands panel and
// `providers.js` each call one of them at the exact line their old method
// ran, and slice 7 deletes those call sites along with `launchpad.js`.
// The host and the openers are resolved PER CALL, never captured, because
// `window.API` and `window.Launchpad` may not exist when this bundle
// evaluates.

/** The seam these flows reach the running app through. */
function createHost(): CreateHost {
    return browserCreateHost();
}

/**
 * Ask how a new claude project should start, then run that flow.
 *
 * Inputs: none. Output: Promise<void>.
 * Example: await window.CloudeWeb.launchpad.startNewClaudeProject();
 */
async function startNewClaudeProjectForLegacy(): Promise<void> {
    await startNewClaudeProjectFlow(createHost(), browserModals(), t);
}

/**
 * Add a session to a project that already exists, never creating one.
 *
 * Inputs: none. Output: Promise<void>.
 * Example: await window.CloudeWeb.launchpad.startSessionInExistingProject();
 */
async function startSessionInExistingProjectForLegacy(): Promise<void> {
    await startSessionInExistingProjectFlow(createHost(), browserModals(), t);
}

/**
 * Create a new project: provider, name, FOLDER, then create.
 *
 * Description: `agentType` null lets the provider picker and then the
 *   server's own fallback chain decide, which is what the default
 *   "+ new project" action has always done.
 * Inputs: agentType (string|null).
 * Output: Promise<void>.
 * Example: await window.CloudeWeb.launchpad.createNewSession();
 */
async function createNewSessionForLegacy(agentType: string | null = null): Promise<void> {
    await createProjectFlow(createHost(), browserModals(), t, agentType);
}

/**
 * Create a bare shell console in `~`, with no name and no folder step.
 *
 * Description: `client/js/terminal-commands-panel.js` calls this through
 *   the launchpad shim to run a configured command in a fresh pane. Only
 *   the command ID travels; the text is read from config.json
 *   server-side and is never accepted from the client.
 * Inputs: options ({terminalCommandId}).
 * Output: Promise<void>.
 * Example: await window.CloudeWeb.launchpad.createConsoleSession({});
 */
async function createConsoleSessionForLegacy(
    options: { terminalCommandId?: string | null } | null = null,
): Promise<void> {
    await createConsoleFlow(createHost(), t, options?.terminalCommandId ?? null);
}

/**
 * Clone a github repo into a new project and open it.
 *
 * Inputs: none. Output: Promise<void>.
 * Example: await window.CloudeWeb.launchpad.cloneFromGithub();
 */
async function cloneFromGithubForLegacy(): Promise<void> {
    await cloneFromGithubFlow(createHost(), browserModals(), t);
}

/**
 * Add a folder already on this machine as a project, and open it.
 *
 * Inputs: none. Output: Promise<void>.
 * Example: await window.CloudeWeb.launchpad.openProjectFromFolder();
 */
async function openProjectFromFolderForLegacy(): Promise<void> {
    await openProjectFromFolderFlow(createHost(), browserModals(), t);
}

/**
 * Archive a project after asking, then refresh the list.
 *
 * Inputs: projectName (string). Output: Promise<void>.
 * Example: await window.CloudeWeb.launchpad.archiveProject('api');
 */
async function archiveProjectForLegacy(projectName: string): Promise<void> {
    await archiveProjectFlow(createHost(), t, projectName);
}

/**
 * Put an archived project back in the default list. No confirm.
 *
 * Inputs: projectName (string). Output: Promise<void>.
 * Example: await window.CloudeWeb.launchpad.unarchiveProject('api');
 */
async function unarchiveProjectForLegacy(projectName: string): Promise<void> {
    await unarchiveProjectFlow(createHost(), t, projectName);
}

/**
 * Rename a project's label and description.
 *
 * Inputs: project (ProjectRow). Output: Promise<void>.
 * Example: await window.CloudeWeb.launchpad.editProject(project);
 */
async function editProjectForLegacy(project: ProjectRow): Promise<void> {
    await editProjectFlow(createHost(), browserModals(), t, project);
}

/**
 * Ask a yes/no, through the app's ONE confirmation modal.
 *
 * Description: this does NOT implement a dialog. `App.showConfirmModal`
 *   owns the escaping, the escape key, the click-outside and the focus,
 *   and this forwards to it. `providers.js:476` still calls
 *   `Launchpad.showConfirmModal`, whose body is now a one-line forward to
 *   this, so there is one path from this screen to that dialog and slice
 *   7 deletes it with the file.
 *
 *   CANCEL IS ALWAYS A NO-OP. A caller must never map false onto a
 *   destructive action.
 * Inputs: title, message, details, primaryLabel, secondaryLabel.
 * Output: Promise<boolean> - true only when confirmed.
 * Example: await window.CloudeWeb.launchpad.confirm('archive project', 'sure?');
 */
function confirmForLegacy(
    title: string,
    message: string,
    details: string | null = null,
    primaryLabel = 'confirm',
    secondaryLabel = 'cancel',
): Promise<boolean> {
    return createHost().confirm(title, message, details, primaryLabel, secondaryLabel);
}


// ---- slice 7: the shell, and the end of client/js/launchpad.js -------
//
// THE SCREEN IS A COMPONENT NOW. `renderLaunchpadUI`'s 363-line template
// string, the six FAB methods, the header help toggle, the three section
// disclosures and their localStorage map, the home bar's version chip and
// server-controls wire, `updateStatus`, `showError` and the eight
// navigation methods all moved here, and `client/js/launchpad.js` was
// deleted in the same commit. What is left of `window.Launchpad` is
// ./lib/launchpad/shim.ts: eight members, each with a named legacy call
// site, published by merging rather than assigning because `providers.js`
// gets there first.

/** The nav seam, resolved per call for the reason nav-host.ts states. */
function navHost() {
    return browserNavHost();
}

/**
 * What each item on the "+" speed dial does.
 *
 * Description: A TABLE, NOT FIVE HANDLERS IN THE TEMPLATE, and that is
 *   the plugin seam's first habit: a `launchpad-panel` or a contributed
 *   entry later is one more key here, not an edit to the shell's markup.
 *   It is built per mount rather than at module scope so every handler
 *   resolves its host at call time.
 * Inputs: none. Output: data-action to handler.
 * Example: fabActions()['new-console']();
 */
function fabActions(): Record<string, FabAction> {
    return {
        'new-claude-project': () => void startNewClaudeProjectForLegacy(),
        'new-session': () => void startSessionInExistingProjectForLegacy(),
        // NO 'open-folder' ENTRY. Opening a folder already on disk is the
        // THIRD choice inside "new claude project", not a peer of it, and
        // `startNewClaudeProject` reaches that flow directly. Only the
        // dead dispatch key went; the flow is very much alive.
        'connect-openclaw': () => void createNewSessionForLegacy('openclaw'),
        'connect-hermes': () => void createNewSessionForLegacy('hermes'),
        'new-console': () => void createConsoleSessionForLegacy({}),
    };
}

/**
 * Mount the home screen. `client/js/app.js:964` calls this ONCE.
 *
 * Description: idempotent, and `app.js` guards it as well with
 *   `Launchpad.launchpadScreen`. It also starts the 5s tick, whose work
 *   is the running-session refetch - the store's own load, with no
 *   repaint attached, because every list on this screen reads the store.
 * Inputs: none. Output: void.
 * Example: window.Launchpad.init();
 */
function initHomeScreen(): void {
    mountHomeScreen(fabActions());
    // Belt and braces: the shell mounts its own panels in `onMount`, and
    // this makes the call again for the case where the shell was already
    // up and only a panel's container had been replaced. Both are map
    // lookups when there is nothing to do.
    mountLaunchpadPanels();
    startSessionPolling(() => sessionStore.loadRunningSessions(t));
}

/**
 * Refetch everything the home screen shows. `app.js:974` calls this on
 * every arrival at the screen.
 *
 * Description: THE SEQUENCER, AND IT NO LONGER REMOUNTS ANYTHING. It
 *   loads the project list and its two sidecars into the store, asks the
 *   two self-fetching panels to refetch, and kicks the running-session
 *   merge. The tree and the running list update because they READ the
 *   store.
 *
 *   RE-RENDERS ON FAILURE, and that is not defensive noise: without it
 *   the archived notice keeps whatever the last SUCCESSFUL fetch painted
 *   - a confident "showing archived: N" sitting on screen after the
 *   request that would have told you failed. Measured in the live
 *   browser 2026-09-06.
 * Inputs: none. Output: Promise<void>. Never rejects.
 * Example: await window.Launchpad.loadProjects();
 */
async function loadHomeScreen(): Promise<void> {
    const result = await sessionStore.loadProjects(uiPrefs.archivedProjectsVisible, t);
    if (!result.ok && result.error) showHomeError(result.error, t);
    refreshLaunchpadPanels();
    // Not awaited: the running merge is independent of the project list
    // and a failure in it is handled inside the store.
    void sessionStore.loadRunningSessions(t);
}

/** The namespace the legacy tree may call into. */
const CloudeWeb = {
    /**
     * The status LED as an HTML string, byte-identical to the legacy
     * SessionStatusUI.dotHtml for every input. This is what a legacy
     * caller that builds a row with innerHTML would use.
     */
    ledHtml: ledHtmlForStatus,
    /** The low-level two-dimension LED module, for callers that need it. */
    led,
    labelFor,
    labelWithSource,
    normalizeStatus,
    /** The Svelte component itself, for a parent that can mount one. */
    StatusLed,
    renderProbe,
    /**
     * THE ONLY MOUNT PATH. Every panel a migration slice moves out of
     * client/js is mounted through this, by container id, so there is
     * exactly one place that owns a live component handle. Nothing else
     * may call Svelte's `mount()` on an element that is in the document.
     */
    mountPanel,
    unmountPanel,
    /** Panels that belong to the launchpad screen, by name. */
    launchpadIsVisible,
    launchpad: {
        mountAttributionPrompt,
        mountRecentSessions,
        /**
         * SLICE 4: THE PROJECT TREE. One call, idempotent, at the line
         * `renderProjectList()`'s `innerHTML` write used to be.
         */
        mountProjectTree,
        /**
         * SLICE 5: THE RUNNING SESSIONS LIST. One call, idempotent, at
         * the line `renderRunningSessions()`'s `innerHTML` write used to
         * be.
         */
        mountRunningSessions,
        /**
         * THE TWO NAMING RULES THE REST OF THE APP STILL ASKS THIS
         * SURFACE FOR. `app.js` wants the slug derivation for a deep
         * link; the project tree wants the full label chain for a row.
         * Both were methods on `Launchpad` until slice 5 moved them, and
         * both are exported rather than copied, because a session named
         * one thing in the tab title and another on a card is a bug this
         * app has already shipped.
         */
        displayNameFor: displayNameForLegacy,
        sessionDisplayLabel: sessionDisplayLabelForLegacy,
        archivedProjectsVisible,
        /**
         * SLICE 3: THE SESSION DATA LAYER, AND THE ONLY COPY OF IT.
         * `client/js/launchpad.js` holds no `projects`, no
         * `runningSessions`, no attribution maps and no work-stamp index
         * any more - the fields its surviving renderers read are accessor
         * properties delegating to `sessionStore`. Exposed as the store
         * itself rather than as a set of forwarding methods because the
         * accessors need to READ it, and a read through a method call is
         * a snapshot that goes stale the moment the next tick lands.
         */
        sessions: sessionStore,
        loadProjects: loadProjectsForLegacy,
        loadRunningSessions: loadRunningSessionsForLegacy,
        loadSessionAttribution: loadSessionAttributionForLegacy,
        startSessionPolling,
        stopSessionPolling,
        workStampFor: workStampForLegacy,
        /**
         * THE THREE RECENT ACTIONS, AS THE STILL-LEGACY ROWS SEE THEM.
         * The project tree (slice 4) archives and restarts; the running
         * row (slice 5) forks. Exported so those two surfaces call the
         * one implementation instead of keeping a copy each, which is
         * how the archive control and the restart notice drifted into
         * meaning different things on different rows before.
         */
        archiveSessionRecord: archiveSessionRecordForLegacy,
        forkSession: forkSessionForLegacy,
        restartRecentSession: restartRecentSessionForLegacy,
        /**
         * SLICE 6: THE MODALS AND THE CREATE FLOWS. Seventeen methods
         * left `launchpad.js` for these eleven entry points. The ORDER
         * inside `createNewSession` is the load-bearing part: provider,
         * name, FOLDER, create - and a cancel at any step creates
         * nothing at all. See web/src/lib/launchpad/create-flow.ts for
         * the four rules it exists to keep.
         */
        startNewClaudeProject: startNewClaudeProjectForLegacy,
        startSessionInExistingProject: startSessionInExistingProjectForLegacy,
        createNewSession: createNewSessionForLegacy,
        createConsoleSession: createConsoleSessionForLegacy,
        cloneFromGithub: cloneFromGithubForLegacy,
        openProjectFromFolder: openProjectFromFolderForLegacy,
        archiveProject: archiveProjectForLegacy,
        unarchiveProject: unarchiveProjectForLegacy,
        editProject: editProjectForLegacy,
        confirm: confirmForLegacy,
        /**
         * SLICE 7: THE SHELL. `mountHomeScreen` is what `Launchpad.init`
         * became and `loadHomeScreen` is what `Launchpad.loadProjects`
         * became; the rest are the navigation glue, exported because the
         * create flows (slice 6) reach three of them and because a test
         * needs a way in that is not a global.
         */
        mountHomeScreen: initHomeScreen,
        unmountHomeScreen,
        refreshLaunchpadPanels,
        loadHomeScreen,
        openProjectByName: (name: string) => openProjectByNameFlow(name, navHost(), t),
        selectProject: (project: ProjectRow, choice?: Record<string, unknown> | null) =>
            selectProjectFlow(project, navHost(), t, choice),
        detachAndOpenProject: (project: ProjectRow) =>
            detachAndOpenProjectFlow(project, navHost(), t),
        detachAndCreateNew: (agentType: string | null) =>
            detachAndCreateNewFlow(agentType, navHost(), t, createNewSessionForLegacy),
        connectToExistingSession: () => connectToExistingSessionFlow(navHost(), t),
        explainRefusedProject,
        isResolvingDeepLink,
        updateStatus,
        showError: (message: string) => showHomeError(message, t),
        terminalDims: () => navHost().terminalDims(),
    },
    /**
     * THE `session-card-action` SURFACE, as the legacy row menu sees it.
     * `sessionCardMenuItems` hands back the enabled contributions for one
     * row as ITEM DESCRIPTORS - id, shortcut, label, order - to be merged
     * into that menu's own declarative table and rendered by it;
     * `runSessionCardAction` is the return trip, taking the item id off
     * the activated `data-row-menu-item`. TWO ENTRY POINTS BECAUSE THERE
     * ARE TWO MOMENTS, paint and run, and each has exactly one call site:
     * `session-row-menu.js::pluginMenuItems` and
     * `session-row-menu-actions.js::runPluginItem`. See
     * web/src/lib/plugins/types.ts for why plugins are build-time only.
     */
    sessionCardMenuItems,
    runSessionCardAction,
    /**
     * THE STRING LAYER, AS THIS TREE SEES IT. Note what is NOT here: a
     * catalog. The messages live in client/js/i18n/, `boot.js` publishes
     * the one instance as `window.CloudeI18n` before this bundle
     * evaluates, and this adopts that object rather than building a
     * second one - two instances would be two current locales.
     *
     * `t` here is the REACTIVE one: it reads a `$state` counter before
     * delegating, so any component template that calls it repaints when
     * `setLocale` moves. A legacy caller wants `window.CloudeI18n.t`
     * instead, which is the same function without the rune, because a
     * classic script has nothing to repaint.
     */
    i18n: { t, setLocale, currentLocale, instance: i18n },
    /**
     * The group summary sentence, from the SHARED assembler in
     * client/js/labels/session-summary.js. The legacy tree reaches the
     * same module through `window.CloudeLabels`, so the sidebar header
     * and any Svelte surface cannot render two different sentences for
     * one state - web/src/lib/session-summary-label.parity.test.ts holds
     * them to it across the whole matrix.
     */
    sessionSummaryLabel: summaryLabel,
} as const;

declare global {
    interface Window {
        CloudeWeb: typeof CloudeWeb;
    }
}

// Published rather than assigned over: if something already claimed this
// name, that is a collision worth failing loudly on rather than winning
// silently.
if (window.CloudeWeb) {
    throw new Error('window.CloudeWeb is already defined - two bundles are loaded');
}
window.CloudeWeb = CloudeWeb;

// THE LAST THING THIS BUNDLE DOES, and the order is the point: the shim
// forwards into `CloudeWeb`, so `CloudeWeb` has to be published first.
// It MERGES into whatever `window.Launchpad` already holds, because
// `client/js/providers.js` is a classic script and put the launch picker
// there before this module ran. See ./lib/launchpad/shim.ts.
publishLaunchpadShim({
    launchpadScreen,
    init: initHomeScreen,
    loadProjects: loadHomeScreen,
    loadRunningSessions: () => sessionStore.loadRunningSessions(t),
    openProjectByName: (name: string) => openProjectByNameFlow(name, browserNavHost(), t),
    showError: (message: string) => showHomeError(message, t),
    selectProject: (project: ProjectRow, choice?: Record<string, unknown> | null) =>
        selectProjectFlow(project, browserNavHost(), t, choice),
});
