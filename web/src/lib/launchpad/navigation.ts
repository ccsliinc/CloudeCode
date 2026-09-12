/**
 * How the home screen enters a session, and the two rules it may never
 * break while doing it.
 *
 * RULE ONE: DEEP-LINK RESOLUTION NEVER CREATES A SESSION. `openProjectByName`
 * used to check the launcher projects FIRST and, on a match, call
 * `selectProject` - which unconditionally calls `POST /sessions`.
 * `create_session()` server-side deliberately NEVER attaches to an
 * existing tmux session for a project click, so on a name collision it
 * silently minted `<name>-2`, `<name>-3` and returned THAT. A deep link
 * to a project that already had a live session therefore always created
 * a duplicate and left the browser on the new one's URL. Live sessions
 * are resolved FIRST now, and a launcher-project match is no longer used
 * to justify creating anything for a deep link at all. `resolvingDeepLink`
 * is the SECOND line of defence: `selectProject` refuses outright while
 * it is set, so a future refactor that re-wires the two together fails
 * loudly instead of silently regressing.
 *
 * RULE TWO: A LISTING THAT DID NOT RUN IS NOT AN EMPTY LISTING. On a cold
 * page load a deep link can arrive before the session list is fetchable -
 * auth has just settled, the first poll has not happened. That records
 * `ok === false` and does NOT throw, so the old single attempt proceeded
 * with an empty row set, found nothing, and rejected the URL. The symptom
 * was baffling because ONE class of name survived: a slug that was also a
 * launcher project fell through and opened anyway. The ladder retries
 * only while it CANNOT DETERMINE; a listing that ran and genuinely
 * returned nothing is an answer, and it is taken.
 *
 * NOTHING HERE PAINTS A THEME. `ThemeNavigation.applyForTarget` is total
 * and owns every hop; a component or a flow that applied one on its own
 * would leave the previous session's theme on screen for whichever path
 * it forgot. See gotcha 7 in CLAUDE.md.
 */
import { HOME_KEYS, failureReason } from '../../../../client/js/labels/home-screen.js';
import { findRunningSessionBySlug } from './deep-link';
import { showError, updateStatus, explainRefusedProject } from './status-report';
import { beginNav, currentNav, keepNav, withNav } from './nav-generation';
import type { NavHost, SessionLike } from './nav-host';
import type { ProjectRow, RunningSessionRow } from '../sessions/types';
import type { Translate } from './recent';

/** How many times the deep-link ladder re-asks an unreadable listing. */
export const DEEP_LINK_ATTEMPTS = 5;

/** How long it waits between those attempts. */
export const DEEP_LINK_BACKOFF_MS = 300;

/**
 * How long a detach is given to finish before the re-create lands.
 *
 * ZERO, AND THE AWAIT ABOVE IT IS WHY. This was 500 ms, described as
 * letting the server finish clearing its backend handles before the
 * create lands. It already has: `POST /sessions/detach` runs
 * `detach_current_session`, which AWAITS the idle watcher's `stop()` and
 * awaits the cancelled reader task before the handler returns, so the
 * response the caller just awaited IS the completion signal. The timer
 * was waiting for something that had already happened.
 *
 * Kept as a named constant rather than deleted with its call sites, so
 * the wait is one edit away if a future teardown stops being awaited, and
 * so `host.wait` keeps its seam for a test that wants to drive the gap.
 */
export const DETACH_SETTLE_MS = 0;

/**
 * The guard flag, and the ONLY writer of it.
 *
 * Description: module state rather than a rune, because nothing renders
 *   it - it is an invariant, not a view. Exposed through two functions so
 *   the one place that sets it is greppable and a test can read it
 *   without reaching into the module's internals.
 */
let resolvingDeepLink = false;

/** Whether a deep-link resolution is in flight. */
export function isResolvingDeepLink(): boolean {
    return resolvingDeepLink;
}

/**
 * Jump straight into an already-active session's terminal.
 *
 * Description: the same pre-fit and scrollback capture a row click does,
 *   so a mouse click and a resolved `/session/<name>` cannot drift.
 * Inputs: sessionId; host; t.
 * Output: Promise<void>. Shows an inline error on failure.
 * Example: await returnToActiveSession('ses_a1b2', host, t);
 */
export async function returnToActiveSession(
    sessionId: string | null,
    host: NavHost,
    t: Translate,
): Promise<void> {
    // THE INTENT, DECLARED BEFORE ANY AWAIT. This path awaits twice -
    // the terminal prepare (which is itself xterm init plus a layout
    // settle plus a fit) and the session fetch - and a card click landing
    // in either of them must win.
    const nav = beginNav('session:' + String(sessionId ?? ''));
    try {
        const { cols, rows } = await host.prepareTerminal();
        const info = await host.getSession(sessionId, {
            includeScrollback: true,
            cols,
            rows,
        });
        if (!keepNav(nav, 'launcher rejoin')) return;
        if (info) host.returnToExistingTerminal(info as SessionLike);
    } catch (error) {
        showError(t(HOME_KEYS.returnFailed, { reason: failureReason(error, t) }), t);
    }
}

/**
 * Adopt a running tmux session this app did not create, and enter it.
 *
 * Description: PURELY ADDITIVE - adopting does not detach or kill any
 *   other session.
 *
 *   THE ADOPT RESPONSE HAS NO LABEL, and the header and the tab title are
 *   both resolved from one. `Session` carries the tmux handle, not the
 *   user's chosen name, so attaching this way titled the tab
 *   `ScratchLab-4_fork` while entering the SAME session from the sidebar
 *   titled it `Refactor spike (round 2)`. The label is already in hand -
 *   the listing row is what we matched to decide to attach - so it is
 *   carried across rather than widening the Session model, and a label
 *   the response DID supply is never overwritten.
 * Inputs: tmuxName; host; t.
 * Output: Promise<void>.
 * Example: await attachRunningSession('cloude_api', host, t);
 */
export async function attachRunningSession(
    tmuxName: string,
    host: NavHost,
    t: Translate,
): Promise<void> {
    // THE INTENT, DECLARED BEFORE THE POST. Every session-created
    // dispatcher declares its navigation here so a row clicked while this
    // request is in flight wins; app.js's session-created listener is the
    // one place that checks it.
    const nav = beginNav('attach:' + tmuxName);
    try {
        const response = await host.adoptSession(tmuxName, true);
        const session = (response.session || response) as SessionLike;
        if (session && !session.label) {
            const known = host.runningSessions().find((row) => row.name === tmuxName);
            if (known && known.label) session.label = known.label;
        }
        const initialScrollbackB64 = response.initial_scrollback_b64 || '';
        const fifoStartOffset =
            typeof response.fifo_start_offset === 'number' ? response.fifo_start_offset : null;

        if (session && session.working_dir) {
            try {
                // Strip the `cloude_` tmux-namespace prefix the server
                // adds when minting the name, or the project row stores
                // `cloude_<name>` and the next launch double-prefixes it
                // to `cloude_cloude_<name>`.
                const rawName = String(session.tmux_session || tmuxName);
                await host.createProject({
                    name: rawName.replace(/^cloude_/, ''),
                    path: session.working_dir,
                    description: '',
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error ?? '');
                if (!message.includes('already exists')) {
                    console.error('CloudeWeb: failed to save the adopted project:', error);
                }
            }
            try {
                // Guarded on its own: the session WAS adopted, and a
                // failed repaint must not read as a failed adopt.
                await host.reloadProjects();
            } catch (error) {
                console.error('CloudeWeb: failed to refresh projects after adopt:', error);
            }
        }

        host.announceSessionCreated(withNav({
            session,
            initialScrollbackB64,
            fifoStartOffset,
            adopted: true,
        }, nav));
    } catch (error) {
        showError(t(HOME_KEYS.attachFailed, { reason: failureReason(error, t) }), t);
    }
}

/**
 * Resolve a deep-link target to a live session, retrying only while the
 * listing CANNOT DETERMINE.
 *
 * Description: separated from `openProjectByName` because the ladder is
 *   the part worth testing and it needs no DOM. It re-asks the listing up
 *   to `DEEP_LINK_ATTEMPTS` times, breaking the moment either a row
 *   matches or the listing answers that it ran and found nothing.
 * Inputs: target; host.
 * Output: the matching row, or null.
 * Example: await resolveDeepLink('api-2', host);
 */
export async function resolveDeepLink(
    target: string,
    host: NavHost,
): Promise<RunningSessionRow | null> {
    for (let attempt = 0; attempt < DEEP_LINK_ATTEMPTS; attempt += 1) {
        try {
            await host.reloadRunningSessions();
        } catch (error) {
            console.warn('CloudeWeb: session refresh during deep-link resolve failed:', error);
        }
        const match = findRunningSessionBySlug(host.runningSessions(), target);
        if (match) return match;
        if (host.runningListingOk()) return null; // it looked, there is nothing
        console.warn(
            'CloudeWeb: session listing unavailable during deep-link resolve ' +
                `(attempt ${attempt + 1}), reason=${host.runningListingReason() || 'unknown'}`,
        );
        await host.wait(DEEP_LINK_BACKOFF_MS);
    }
    return null;
}

/**
 * Open a live session by the name a deep link carries.
 *
 * Description: RULE ONE lives here. It resolves live sessions and only
 *   live sessions; a miss reaches `Router.rejectTarget`, which shows the
 *   banner and cleans the URL back to `/`. It deliberately does NOT
 *   consult the launcher projects on a miss - a project name with no
 *   live session is indistinguishable from "nothing to reattach to" and
 *   is reported the same way.
 * Inputs: name - decoded, validated slug from the URL; host; t.
 * Output: Promise<void>.
 * Example: await openProjectByName('api-2', host, t);
 */
export async function openProjectByName(
    name: string,
    host: NavHost,
    t: Translate,
): Promise<void> {
    resolvingDeepLink = true;
    // READS the generation the router declared for this deep link, never
    // begins one. The retry ladder below can spend well over a second,
    // and a conversation row clicked inside that window must win. The two
    // handlers it dispatches to declare their own generation once this
    // check passes, which is correct: the check is what proves this deep
    // link is still the navigation on screen.
    const deepLinkNav = currentNav();
    try {
        const session = await resolveDeepLink(name, host);
        if (!keepNav(deepLinkNav, 'deep-link resolve')) return;
        if (session) {
            if (session.is_active) {
                await returnToActiveSession(session.session_id || null, host, t);
            } else {
                await attachRunningSession(String(session.name ?? ''), host, t);
            }
            return;
        }
        console.warn('CloudeWeb: deep-link target not found among live sessions:', name);
        if (!host.rejectTarget(name)) {
            // Only when the router cannot show its own banner. Never a
            // silent bounce to `/`, and never a native alert().
            showError(t(HOME_KEYS.sessionNotFound, { name }), t);
        }
    } finally {
        resolvingDeepLink = false;
    }
}

/**
 * Open a launcher project in a NEW session.
 *
 * Description: RULE ONE's second line of defence is the first thing in
 *   here. `providerChoice` may be passed when the caller already gated
 *   its own pre-session side effect on the picker, which avoids prompting
 *   twice; `undefined` means show it, and a `null` answer from it is a
 *   cancelled launch that creates nothing and reports nothing.
 * Inputs: project; host; t; providerChoice.
 * Output: Promise<void>.
 * Throws: when a deep-link resolution is in flight, so the regression
 *   cannot come back silently.
 * Example: await selectProject(project, host, t);
 */
export async function selectProject(
    project: ProjectRow,
    host: NavHost,
    t: Translate,
    providerChoice: Record<string, unknown> | null | undefined = undefined,
): Promise<void> {
    const name = String(project?.name ?? '');
    // THE INTENT, DECLARED BEFORE THE POST, and before the provider
    // picker too: the picker is an await the user can sit in for as long
    // as they like, which is the widest window on this screen.
    const nav = beginNav('project:' + name);
    if (resolvingDeepLink) {
        const error = new Error(t(HOME_KEYS.deepLinkRefusesCreate, { name }));
        console.error('CloudeWeb: BLOCKED create-session during deep-link resolution:', error);
        host.rejectTarget(name);
        throw error;
    }

    try {
        let choice = providerChoice;
        if (choice === undefined) {
            choice = await host.chooseProvider();
            if (!choice) return;
        }
        updateStatus(t(HOME_KEYS.statusOpening, { name }));

        const payload: Record<string, unknown> = {
            working_dir: project.path,
            auto_start_claude: true,
            copy_templates: false,
            project_name: name,
            // The label becomes claude's `--name` as well as the row
            // title, so opening a project names the session on both
            // sides at once.
            label: name,
            ...host.terminalDims(),
        };
        if (choice?.model) payload.model = choice.model;
        if (choice?.wrapperId) payload.agent_type = choice.wrapperId;
        else if (choice?.agentType) payload.agent_type = choice.agentType;

        const session = await host.createSession(payload);
        host.announceSessionCreated(withNav({ session, project }, nav));
    } catch (error) {
        console.error('CloudeWeb: failed to open project:', error);
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (message.includes('already running')) {
            // SWAP rather than refuse. The old tmux session is DETACHED,
            // not destroyed, so it keeps running and reappears in the
            // running list for a later rejoin.
            await detachAndOpenProject(project, host, t);
        } else {
            showError(t(HOME_KEYS.openFailed, { name, reason: failureReason(error, t) }), t);
        }
    }
}

/**
 * Detach the running session, then open the picked project in a fresh one.
 *
 * Description: the brief delay lets the server finish clearing its
 *   backend handles before the create lands, which avoids a race with a
 *   backend still tearing down.
 * Inputs: project; host; t. Output: Promise<void>.
 * Example: await detachAndOpenProject(project, host, t);
 */
export async function detachAndOpenProject(
    project: ProjectRow,
    host: NavHost,
    t: Translate,
): Promise<void> {
    try {
        updateStatus(t(HOME_KEYS.statusDetaching));
        await host.detachSession();
        await host.wait(DETACH_SETTLE_MS);
    } catch (error) {
        console.error('CloudeWeb: failed to detach session:', error);
        showError(t(HOME_KEYS.detachFailed, { reason: failureReason(error, t) }), t);
        return;
    }
    // THE OPEN GETS ITS OWN CATCH, BECAUSE IT IS ITS OWN FAILURE. Folded
    // into the block above, a project that failed to OPEN was reported to
    // the user as a session that failed to DETACH - a sentence naming the
    // wrong step, about a detach that had in fact just succeeded.
    try {
        await selectProject(project, host, t);
    } catch (error) {
        console.error('CloudeWeb: failed to open the project after detach:', error);
        showError(
            t(HOME_KEYS.openFailed, {
                name: String(project?.name ?? ''),
                reason: failureReason(error, t),
            }),
            t,
        );
    }
}

/**
 * Detach the running session, then create a brand new one.
 *
 * Description: the mirror of `detachAndOpenProject` for the create path.
 *   `agentType` is honoured so the replacement lands on the same CLI the
 *   user originally picked; null lets the picker and then the server's
 *   own fallback chain decide.
 * Inputs: agentType; host; t; createNew - the create flow to run after.
 * Output: Promise<void>.
 * Example: await detachAndCreateNew(null, host, t, createNewSession);
 */
export async function detachAndCreateNew(
    agentType: string | null,
    host: NavHost,
    t: Translate,
    createNew: (agentType: string | null) => Promise<unknown> | unknown,
): Promise<void> {
    try {
        updateStatus(t(HOME_KEYS.statusDetaching));
        await host.detachSession();
        await host.wait(DETACH_SETTLE_MS);
    } catch (error) {
        console.error('CloudeWeb: failed to detach session:', error);
        showError(t(HOME_KEYS.detachFailed, { reason: failureReason(error, t) }), t);
        return;
    }
    // Its own catch, for the reason spelled out in `detachAndOpenProject`.
    // IT LOGS AND DOES NOT RAISE A SECOND BANNER: `createProjectFlow`
    // catches its own failures and calls `showError` itself, so anything
    // arriving here is a throw that flow did not expect, and a banner
    // here would double up on the common path. Logged rather than
    // swallowed, because an unexpected throw is exactly what a later
    // reader needs to see.
    try {
        await createNew(agentType || null);
    } catch (error) {
        console.error('CloudeWeb: failed to create a session after detach:', error);
    }
}

/**
 * Enter whatever session the server calls the active one.
 *
 * Inputs: host; t. Output: Promise<void>.
 * Example: await connectToExistingSession(host, t);
 */
export async function connectToExistingSession(host: NavHost, t: Translate): Promise<void> {
    // THE INTENT, DECLARED BEFORE THE GET, for the reason given on every
    // other dispatcher here.
    const nav = beginNav('existing');
    try {
        updateStatus(t(HOME_KEYS.statusConnecting));
        const data = await host.getSession();
        const session = ((data as { session?: SessionLike }).session || data) as SessionLike;
        host.announceSessionCreated(withNav({ session }, nav));
    } catch (error) {
        console.error('CloudeWeb: failed to get the existing session:', error);
        showError(t(HOME_KEYS.connectFailed, { reason: failureReason(error, t) }), t);
    }
}

export { explainRefusedProject };
